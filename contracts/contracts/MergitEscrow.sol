// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MergitEscrow
/// @author Daniel Francia — Mergit (GASOK 2026, Track 04 AI/Web3)
/// @notice Escrow de bounties para desarrolladores en GIWA.
///
///         Un financiador (protocolo, fondo del ecosistema o DAO) publica un bounty
///         bloqueando ETH y designando un verificador — el agente de IA de Mergit.
///         Cuando el agente confirma que el trabajo existe de verdad (PR mergeado,
///         CI en verde, contrato desplegado), libera el escrow al desarrollador.
///         Si nadie entrega antes del plazo, el financiador recupera sus fondos.
///
/// @dev    Decisiones de diseño deliberadas:
///         - Sin owner, sin pausa y sin upgradabilidad: nadie —ni el autor— puede
///           tocar fondos ajenos. Es el núcleo del argumento "trustless" de Mergit.
///         - El verificador solo puede elegir *a quién* se paga, nunca desviar los
///           fondos a sí mismo ni cambiar el importe.
///         - La comisión de protocolo se fija en el constructor y es inmutable.
contract MergitEscrow {
    // ─────────────────────────────── Tipos ───────────────────────────────

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Bounty {
        address funder; // quien bloqueó los fondos
        address verifier; // agente autorizado a liberar el pago
        uint256 amount; // wei bloqueados (bruto, comisión incluida)
        uint64 deadline; // tras esta marca de tiempo el financiador puede reembolsarse
        Status status;
    }

    // ────────────────────────────── Constantes ───────────────────────────

    uint16 public constant MAX_FEE_BPS = 500; // techo duro: 5%
    uint16 public constant BPS_DENOMINATOR = 10_000;

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
        string metadataURI
    );

    /// @param evidenceHash Huella de la evidencia que evaluó el agente
    ///        (PR, commit, resultado de CI). Permite auditar cada pago después.
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
    error ZeroAddress();
    error NoFunds();
    error DeadlineInPast();
    error UnknownBounty();
    error NotOpen();
    error NotVerifier();
    error NotFunder();
    error DeadlinePassed();
    error DeadlineNotReached();
    error PayoutFailed();
    error Reentrancy();

    // ─────────────────────────────── Guardia ─────────────────────────────

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ──────────────────────────── Constructor ────────────────────────────

    constructor(uint16 feeBps_, address feeRecipient_) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    // ───────────────────────────── Escritura ─────────────────────────────

    /// @notice Publica un bounty bloqueando el ETH enviado.
    /// @param verifier    Agente autorizado a liquidarlo.
    /// @param deadline    Marca de tiempo tras la cual el financiador puede reembolsarse.
    /// @param metadataURI Referencia off-chain al enunciado (repo, issue, spec).
    /// @return bountyId   Identificador del bounty creado.
    function postBounty(address verifier, uint64 deadline, string calldata metadataURI)
        external
        payable
        returns (uint256 bountyId)
    {
        if (verifier == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert NoFunds();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        bountyId = nextBountyId++;
        _bounties[bountyId] = Bounty({
            funder: msg.sender,
            verifier: verifier,
            amount: msg.value,
            deadline: deadline,
            status: Status.Open
        });

        emit BountyPosted(bountyId, msg.sender, verifier, msg.value, deadline, metadataURI);
    }

    /// @notice El verificador libera el escrow al desarrollador que hizo el trabajo.
    /// @dev    El verificador no puede pagarse a sí mismo ni alterar el importe:
    ///         solo decide el destinatario, y la evidencia queda registrada.
    function settle(uint256 bountyId, address developer, bytes32 evidenceHash) external nonReentrant {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.verifier) revert NotVerifier();
        if (developer == address(0)) revert ZeroAddress();
        if (block.timestamp > b.deadline) revert DeadlinePassed();

        uint256 amount = b.amount;
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 payout = amount - fee;

        // efectos antes que interacciones
        b.status = Status.Settled;

        _send(developer, payout);
        if (fee != 0) _send(feeRecipient, fee);

        emit BountySettled(bountyId, developer, msg.sender, payout, fee, evidenceHash);
    }

    /// @notice Pasado el plazo sin liquidar, el financiador recupera sus fondos.
    function refund(uint256 bountyId) external nonReentrant {
        Bounty storage b = _bounties[bountyId];

        if (b.status == Status.None) revert UnknownBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.funder) revert NotFunder();
        if (block.timestamp <= b.deadline) revert DeadlineNotReached();

        uint256 amount = b.amount;
        b.status = Status.Refunded;

        _send(b.funder, amount);

        emit BountyRefunded(bountyId, b.funder, amount);
    }

    // ───────────────────────────── Lectura ───────────────────────────────

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        Bounty memory b = _bounties[bountyId];
        if (b.status == Status.None) revert UnknownBounty();
        return b;
    }

    /// @notice Desglosa cuánto recibiría el desarrollador y cuánto el protocolo.
    function quote(uint256 amount) external view returns (uint256 payout, uint256 fee) {
        fee = (amount * feeBps) / BPS_DENOMINATOR;
        payout = amount - fee;
    }

    // ───────────────────────────── Interno ───────────────────────────────

    function _send(address to, uint256 value) private {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert PayoutFailed();
    }
}
