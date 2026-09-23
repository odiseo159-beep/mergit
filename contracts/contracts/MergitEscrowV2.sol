// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MergitEscrowV2 — el escrow, con derecho a réplica
/// @author Daniel Francia — Mergit (GASOK 2026, Track 04 AI/Web3)
/// @notice Igual que la v1, con una diferencia: el financiador puede objetar un pago
///         antes de que salga. Cada bounty elige cuánto dura esa ventana, y una
///         ventana de cero segundos se comporta exactamente como la v1: el pago cae
///         en el mismo bloque que la verificación.
///
/// @dev    Por qué la ventana es por bounty y no del contrato: el pago instantáneo es
///         el argumento de Mergit, y una espera obligatoria lo destruiría. Quien
///         publica el bounty decide qué prefiere. Un bounty pequeño en un repo propio
///         no necesita ventana; uno grande de un tesoro ajeno probablemente sí.
///
///         El financiador tiene **una** objeción por bounty. Al usarla, el bounty
///         vuelve a estar abierto y el siguiente pago del verificador es inmediato,
///         aunque el bounty tuviera ventana. Así la objeción sirve para corregir un
///         error, no para no pagar nunca.
///
///         Lo que sigue sin resolver, y conviene decirlo: si el financiador objeta
///         con el plazo casi vencido, puede pedir el reembolso antes de que el
///         verificador vuelva a liquidar. Cerrar esa carrera pide un árbitro, que es
///         justo la figura que Mergit intenta no tener. Por ahora la mitigación es
///         que la objeción es única y que volver a liquidar es inmediato.
///
///         Sigue sin owner, sin pausa y sin upgradabilidad. La comisión se fija en el
///         constructor, con el mismo techo del 5%.
contract MergitEscrowV2 {
    // ─────────────────────────────── Tipos ───────────────────────────────

    enum Status {
        None,
        Open, // fondos bloqueados, esperando trabajo
        Pending, // el verificador liquidó; corre la ventana de objeción
        Settled, // pagado
        Refunded // devuelto al financiador
    }

    struct Bounty {
        address funder; // quien bloqueó los fondos
        address verifier; // agente autorizado a liquidar
        uint256 amount; // wei bloqueados (bruto, comisión incluida)
        uint64 deadline; // pasada esta marca, el financiador puede reembolsarse
        uint32 challengeWindow; // segundos de objeción; 0 = pago en el acto
        Status status;
        address developer; // destinatario propuesto o ya pagado
        uint64 claimableAt; // desde cuándo se puede finalizar el pago
        bool challenged; // el financiador ya usó su única objeción
        bytes32 evidenceHash; // huella de la evidencia que evaluó el verificador
    }

    // ────────────────────────────── Constantes ───────────────────────────

    uint16 public constant MAX_FEE_BPS = 500; // techo duro: 5%
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint32 public constant MAX_CHALLENGE_WINDOW = 7 days;

    // ─────────────────────────────── Estado ──────────────────────────────

    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    uint256 public nextBountyId = 1;
    mapping(uint256 => Bounty) private _bounties;

    uint256 private _locked = 1; // guardia de reentrada

    // ─────────────────────────────── Eventos ─────────────────────────────

    event BountyPosted(
        uint256 indexed bountyId,
        address indexed funder,
        address indexed verifier,
        uint256 amount,
        uint64 deadline,
        uint32 challengeWindow,
        string metadataURI
    );

    /// @notice El verificador aprobó un pago que todavía puede objetarse.
    event SettlementProposed(
        uint256 indexed bountyId,
        address indexed developer,
        address indexed verifier,
        uint64 claimableAt,
        bytes32 evidenceHash
    );

    /// @notice El financiador usó su objeción: el bounty vuelve a estar abierto.
    event SettlementChallenged(uint256 indexed bountyId, address indexed funder, address indexed developer);

    event BountySettled(
        uint256 indexed bountyId,
        address indexed developer,
        address indexed verifier,
        uint256 paidToDeveloper,
        uint256 protocolFee,
        bytes32 evidenceHash
    );

    event BountyRefunded(uint256 indexed bountyId, address indexed funder, uint256 amount);

    // ─────────────────────────────── Errores ─────────────────────────────

    error FeeTooHigh();
    error WindowTooLong();
    error ZeroAddress();
    error NoFunds();
    error DeadlinePassed();
    error UnknownBounty();
    error NotOpen();
    error NotPending();
    error NotVerifier();
    error NotFunder();
    error TooEarly();
    error AlreadyChallenged();
    error TransferFailed();

    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(uint16 feeBps_, address feeRecipient_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    // ────────────────────────────── Publicar ─────────────────────────────

    /// @notice Bloquea ETH para un bounty y designa quién puede liquidarlo.
    /// @param challengeWindow Segundos que el financiador tiene para objetar el pago.
    ///        Cero significa que el pago sale en el mismo bloque que la verificación.
    function postBounty(address verifier, uint64 deadline, uint32 challengeWindow, string calldata metadataURI)
        external
        payable
        returns (uint256 bountyId)
    {
        if (verifier == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert NoFunds();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (challengeWindow > MAX_CHALLENGE_WINDOW) revert WindowTooLong();

        bountyId = nextBountyId++;
        Bounty storage b = _bounties[bountyId];
        b.funder = msg.sender;
        b.verifier = verifier;
        b.amount = msg.value;
        b.deadline = deadline;
        b.challengeWindow = challengeWindow;
        b.status = Status.Open;

        emit BountyPosted(bountyId, msg.sender, verifier, msg.value, deadline, challengeWindow, metadataURI);
    }

    // ────────────────────────────── Liquidar ─────────────────────────────

    /// @notice El verificador aprueba el pago al desarrollador que hizo el trabajo.
    /// @dev    Sin ventana, o tras una objeción ya usada, paga en el acto. Con ventana
    ///         deja el pago pendiente hasta que alguien lo finalice.
    function settle(uint256 bountyId, address developer, bytes32 evidenceHash) external nonReentrant {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.verifier) revert NotVerifier();
        if (developer == address(0)) revert ZeroAddress();
        if (block.timestamp > b.deadline) revert DeadlinePassed();

        b.developer = developer;
        b.evidenceHash = evidenceHash;

        if (b.challengeWindow == 0 || b.challenged) {
            _pay(bountyId, b);
            return;
        }

        b.status = Status.Pending;
        b.claimableAt = uint64(block.timestamp) + b.challengeWindow;
        emit SettlementProposed(bountyId, developer, msg.sender, b.claimableAt, evidenceHash);
    }

    /// @notice Pasada la ventana sin objeción, cualquiera puede soltar el pago.
    /// @dev    Lo puede llamar cualquiera a propósito: si el agente desapareciera, el
    ///         desarrollador no se queda sin cobrar lo que ya fue aprobado.
    function finalize(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Pending) revert NotPending();
        if (block.timestamp < b.claimableAt) revert TooEarly();

        _pay(bountyId, b);
    }

    /// @notice El financiador objeta el pago propuesto. Solo una vez por bounty.
    /// @dev    El bounty vuelve a estar abierto y el verificador puede liquidar otra
    ///         vez; esa segunda liquidación ya no espera.
    function challenge(uint256 bountyId) external {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Pending) revert NotPending();
        if (msg.sender != b.funder) revert NotFunder();
        if (b.challenged) revert AlreadyChallenged();
        if (block.timestamp >= b.claimableAt) revert TooEarly();

        address proposed = b.developer;
        b.challenged = true;
        b.status = Status.Open;
        b.developer = address(0);
        b.claimableAt = 0;
        b.evidenceHash = bytes32(0);

        emit SettlementChallenged(bountyId, msg.sender, proposed);
    }

    // ────────────────────────────── Reembolso ────────────────────────────

    /// @notice Pasado el plazo sin liquidar, el financiador recupera sus fondos.
    /// @dev    Solo desde Open: un pago ya propuesto no se le puede quitar al
    ///         desarrollador dejando correr el reloj.
    function refund(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.funder) revert NotFunder();
        if (block.timestamp <= b.deadline) revert TooEarly();

        uint256 amount = b.amount;
        b.status = Status.Refunded;
        _send(b.funder, amount);

        emit BountyRefunded(bountyId, b.funder, amount);
    }

    // ─────────────────────────────── Lecturas ────────────────────────────

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        Bounty memory b = _bounties[bountyId];
        if (b.status == Status.None) revert UnknownBounty();
        return b;
    }

    /// @notice Cuánto le toca al desarrollador y cuánto al protocolo.
    function quote(uint256 amount) external view returns (uint256 payout, uint256 fee) {
        fee = (amount * feeBps) / BPS_DENOMINATOR;
        payout = amount - fee;
    }

    // ──────────────────────────────── Interno ────────────────────────────

    function _pay(uint256 bountyId, Bounty storage b) private {
        uint256 amount = b.amount;
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 payout = amount - fee;

        // efectos antes que interacciones
        b.status = Status.Settled;

        _send(b.developer, payout);
        if (fee != 0) _send(feeRecipient, fee);

        emit BountySettled(bountyId, b.developer, b.verifier, payout, fee, b.evidenceHash);
    }

    function _send(address to, uint256 value) private {
        (bool ok, ) = payable(to).call{value: value}("");
        if (!ok) revert TransferFailed();
    }
}
