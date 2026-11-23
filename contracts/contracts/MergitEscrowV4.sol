// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MergitEscrowV4 — la v3, sin un pago que se pueda quedar atascado
/// @author Daniel Francia — Mergit (GASOK 2026, Track 04 AI/Web3)
/// @notice Igual que la v3 en todo lo demás: mismas funciones, mismo struct, mismos
///         eventos. Cambia qué pasa cuando el ETH no se puede entregar.
///
///         El fallo de la v2 y la v3, encontrado por Aegis el 23 de noviembre de 2026:
///         con ventana de objeción, si la dirección del desarrollador era un contrato
///         que rechaza ETH, `finalize` revertía para siempre. La objeción ya había
///         vencido y `refund` exige `Open`, así que los fondos no salían por ningún lado.
///
///         Las reglas ahora:
///
///         - **`settle` en el acto** sigue revirtiendo si la entrega falla. El bounty
///           sigue `Open`: el verificador puede elegir otra dirección y el financiador
///           conserva su reembolso. Aquí todavía no se aprobó nada.
///         - **`finalize`** ya no puede atascarse. Si la entrega falla, el monto queda
///           acreditado a esa dirección en `owed`, y ella lo saca con `withdrawTo`
///           hacia donde quiera. Un pago ya aprobado no se le quita a nadie.
///         - **`refund`** y **la comisión** se acreditan igual si no se pueden entregar.
///
/// @dev    La entrega lleva un tope de gas y no copia lo que devuelve el destinatario,
///         para que un contrato hostil no pueda consumir el gas de quien llama. Además
///         exige gas suficiente antes de llamar: si no, cualquiera podría llamar a
///         `finalize` con poco gas, hacer fallar la entrega a propósito y obligar al
///         desarrollador a retirar a mano.
///
///         Lo que no resuelve, dicho claro: un contrato que no pueda recibir ETH **ni
///         llamar** a `withdrawTo` pierde lo acreditado, igual que quien recibe un pago
///         en una dirección equivocada. El financiador puede evitarlo objetando dentro
///         de la ventana.
///
///         Sigue sin owner, sin pausa y sin upgradabilidad.
contract MergitEscrowV4 {
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
        uint64 maxDeadline; // hasta dónde puede estirarlo el verificador; == deadline lo desactiva
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
    uint32 public constant MIN_RESETTLE_WINDOW = 1 days; // margen mínimo para liquidar tras una objeción
    uint8 public constant VERSION = 4;
    uint32 public constant PUSH_GAS = 100_000; // gas que recibe el destinatario; alcanza para una billetera de contrato
    // PUSH_GAS con la regla 63/64, el costo de la llamada y lo que cuesta acreditar si falla.
    uint32 public constant MIN_GAS_FOR_PUSH = 170_000;

    // ─────────────────────────────── Estado ──────────────────────────────

    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    uint256 public nextBountyId = 1;
    mapping(uint256 => Bounty) private _bounties;

    /// @notice ETH que no se pudo entregar y que su dueño puede retirar.
    mapping(address => uint256) public owed;

    uint256 private _locked = 1; // guardia de reentrada

    // ─────────────────────────────── Eventos ─────────────────────────────

    event BountyPosted(
        uint256 indexed bountyId,
        address indexed funder,
        address indexed verifier,
        uint256 amount,
        uint64 deadline,
        uint64 maxDeadline,
        uint32 challengeWindow,
        string metadataURI
    );

    /// @notice Alguien movió el plazo hacia adelante. Nunca hacia atrás.
    event DeadlineExtended(
        uint256 indexed bountyId,
        address indexed by,
        uint64 previousDeadline,
        uint64 newDeadline
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

    /// @notice La entrega falló y el monto quedó acreditado a esa dirección.
    event PaymentCredited(uint256 indexed bountyId, address indexed to, uint256 amount);

    /// @notice Alguien retiró lo que tenía acreditado.
    event PaymentWithdrawn(address indexed owner, address indexed to, uint256 amount);

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
    error NotFunderNorVerifier();
    error DeadlineNotLater();
    error BeyondMaxDeadline();
    error TooEarly();
    error AlreadyChallenged();
    error TransferFailed();
    error NotEnoughGas();
    error NothingOwed();

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
    /// @param maxDeadline Hasta dónde puede estirar el plazo el verificador. Igual a
    ///        `deadline` significa que no puede moverlo en absoluto.
    function postBounty(
        address verifier,
        uint64 deadline,
        uint64 maxDeadline,
        uint32 challengeWindow,
        string calldata metadataURI
    )
        external
        payable
        returns (uint256 bountyId)
    {
        if (verifier == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert NoFunds();
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (maxDeadline < deadline) revert DeadlineNotLater();
        if (challengeWindow > MAX_CHALLENGE_WINDOW) revert WindowTooLong();

        bountyId = nextBountyId++;
        Bounty storage b = _bounties[bountyId];
        b.funder = msg.sender;
        b.verifier = verifier;
        b.amount = msg.value;
        b.deadline = deadline;
        b.maxDeadline = maxDeadline;
        b.challengeWindow = challengeWindow;
        b.status = Status.Open;

        emit BountyPosted(bountyId, msg.sender, verifier, msg.value, deadline, maxDeadline, challengeWindow, metadataURI);
    }

    // ─────────────────────────────── Extender ────────────────────────────

    /// @notice Mueve el plazo hacia adelante, nunca hacia atrás.
    /// @dev    El financiador no tiene tope: es su dinero. El verificador llega hasta
    ///         `maxDeadline`, que el financiador fijó al publicar.
    ///
    ///         Solo mientras está `Open`. Con un pago ya propuesto no hay nada que
    ///         salvar del reloj: `finalize` no mira el plazo.
    function extend(uint256 bountyId, uint64 newDeadline) external {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (newDeadline <= b.deadline) revert DeadlineNotLater();

        if (msg.sender == b.verifier) {
            if (newDeadline > b.maxDeadline) revert BeyondMaxDeadline();
        } else if (msg.sender != b.funder) {
            revert NotFunderNorVerifier();
        }

        uint64 anterior = b.deadline;
        b.deadline = newDeadline;
        // El tope sube con el plazo cuando lo mueve el financiador: si no, extender
        // una vez dejaría al verificador con menos margen que antes, no con más.
        if (newDeadline > b.maxDeadline) b.maxDeadline = newDeadline;

        emit DeadlineExtended(bountyId, msg.sender, anterior, newDeadline);
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
            _pay(bountyId, b, false);
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

        _pay(bountyId, b, true);
    }

    /// @notice El financiador objeta el pago propuesto. Solo una vez por bounty.
    /// @dev    El bounty vuelve a estar abierto y el verificador puede liquidar otra
    ///         vez; esa segunda liquidación ya no espera. El verificador conserva como
    ///         mínimo `MIN_RESETTLE_WINDOW`, o la ventana del bounty si es mayor: si al
    ///         plazo le queda menos, se mueve hacia adelante. El tope sube con él si
    ///         el nuevo plazo lo deja atrás.
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

        // Si la objeción llega con el plazo encima, el verificador necesita tiempo
        // real para volver a liquidar. El plazo solo se mueve hacia adelante.
        uint32 margen = b.challengeWindow > MIN_RESETTLE_WINDOW ? b.challengeWindow : MIN_RESETTLE_WINDOW;
        uint64 nuevoPlazo = uint64(block.timestamp) + margen;
        if (b.deadline < nuevoPlazo) {
            uint64 anterior = b.deadline;
            b.deadline = nuevoPlazo;
            if (nuevoPlazo > b.maxDeadline) b.maxDeadline = nuevoPlazo;
            emit DeadlineExtended(bountyId, msg.sender, anterior, nuevoPlazo);
        }

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
        if (!_push(b.funder, amount)) _credit(bountyId, b.funder, amount);

        emit BountyRefunded(bountyId, b.funder, amount);
    }

    // ─────────────────────────────── Retirar ─────────────────────────────

    /// @notice Saca lo acreditado a `msg.sender` y lo manda a `to`.
    /// @dev    Si la entrega falla, revierte y el saldo sigue ahí: se puede reintentar
    ///         con otra dirección.
    function withdrawTo(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();

        owed[msg.sender] = 0;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit PaymentWithdrawn(msg.sender, to, amount);
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

    /// @param creditOnFailure En `finalize` el pago ya fue aprobado y no puede atascarse.
    ///        En `settle` directo conviene revertir: el verificador aún puede corregir.
    function _pay(uint256 bountyId, Bounty storage b, bool creditOnFailure) private {
        uint256 amount = b.amount;
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 payout = amount - fee;

        // efectos antes que interacciones
        b.status = Status.Settled;

        if (!_push(b.developer, payout)) {
            if (!creditOnFailure) revert TransferFailed();
            _credit(bountyId, b.developer, payout);
        }
        if (fee != 0 && !_push(feeRecipient, fee)) _credit(bountyId, feeRecipient, fee);

        emit BountySettled(bountyId, b.developer, b.verifier, payout, fee, b.evidenceHash);
    }

    /// @dev Tope de gas y cero bytes de retorno copiados: el destinatario no puede
    ///      consumir el gas de quien llama ni inflarle la memoria.
    function _push(address to, uint256 value) private returns (bool ok) {
        if (gasleft() < MIN_GAS_FOR_PUSH) revert NotEnoughGas();
        assembly ("memory-safe") {
            ok := call(PUSH_GAS, to, value, 0, 0, 0, 0)
        }
    }

    function _credit(uint256 bountyId, address to, uint256 amount) private {
        owed[to] += amount;
        emit PaymentCredited(bountyId, to, amount);
    }
}
