// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MergitEscrowV3 — el escrow, con un plazo que se puede mover
/// @author Daniel Francia — Mergit (GASOK 2026, Track 04 AI/Web3)
/// @notice Igual que la v2, más una cosa que costó cara: **el plazo se puede extender**.
///
/// El resto del contrato sigue la lógica de la v2, con la única diferencia
/// de que ahora, cuando el financiador objeta (`challenge`) y queda menos
/// tiempo que la ventana de objeción (`challengeWindow`) antes del plazo
/// original, el plazo se extiende automáticamente.

contract MergitEscrowV3 {
    // ---------------------------------------------------------------------
    //  Variables de configuración
    // ---------------------------------------------------------------------
    uint256 public immutable feeBps;
    address public immutable feeRecipient;

    // ---------------------------------------------------------------------
    //  Estructuras y eventos
    // ---------------------------------------------------------------------
    struct Bounty {
        address funder;
        address verifier;
        uint256 deadline;      // plazo actual
        uint256 maxDeadline;   // tope máximo al que puede extenderse
        uint256 challengeWindow; // ventana de objeción en segundos
        string repo;
        uint256 amount;        // ETH bloqueado
        bool challenged;
        bool settled;
    }

    mapping(uint256 => Bounty) public bounties;
    uint256 public nextBountyId = 1;

    event BountyPosted(uint256 indexed bountyId, address indexed funder, address indexed verifier, uint256 deadline, uint256 maxDeadline, uint256 challengeWindow, string repo, uint256 amount);
    event DeadlineExtended(uint256 indexed bountyId, uint256 newDeadline);
    event BountyExtended(uint256 indexed bountyId, uint256 newDeadline);
    event BountySettled(uint256 indexed bountyId, address developer, bytes32 evidence);
    event BountyRefunded(uint256 indexed bountyId);

    // ---------------------------------------------------------------------
    //  Constructor
    // ---------------------------------------------------------------------
    constructor(uint256 _feeBps, address _feeRecipient) {
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
    }

    // ---------------------------------------------------------------------
    //  Funciones públicas
    // ---------------------------------------------------------------------
    /// @notice Publica un nuevo bounty.
    function postBounty(
        address verifier,
        uint256 deadline,
        uint256 maxDeadline,
        uint256 challengeWindow,
        string calldata repo
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "AmountZero");
        require(deadline <= maxDeadline, "DeadlineAfterMax");
        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            funder: msg.sender,
            verifier: verifier,
            deadline: deadline,
            maxDeadline: maxDeadline,
            challengeWindow: challengeWindow,
            repo: repo,
            amount: msg.value,
            challenged: false,
            settled: false
        });
        emit BountyPosted(bountyId, msg.sender, verifier, deadline, maxDeadline, challengeWindow, repo, msg.value);
    }

    /// @notice Extiende el plazo. Puede ser llamado por el financiador sin límite o por el verificador hasta `maxDeadline`.
    function extend(uint256 bountyId, uint256 newDeadline) external {
        Bounty storage b = bounties[bountyId];
        require(msg.sender == b.funder || msg.sender == b.verifier, "NotAuthorized");
        if (msg.sender == b.verifier) {
            require(newDeadline <= b.maxDeadline, "ExceedsMax");
        }
        require(newDeadline > b.deadline, "NotLater");
        b.deadline = newDeadline;
        emit BountyExtended(bountyId, newDeadline);
    }

    /// @notice El financiador objeta el pago. Si queda menos tiempo que la ventana de objeción, el plazo se extiende.
    function challenge(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];
        require(msg.sender == b.funder, "OnlyFunder");
        require(block.timestamp <= b.deadline, "TooLate");
        b.challenged = true;
        // Si queda menos tiempo que la ventana de objeción, extender el plazo.
        if (b.deadline - block.timestamp < b.challengeWindow) {
            uint256 newDeadline = block.timestamp + b.challengeWindow;
            if (newDeadline > b.maxDeadline) {
                newDeadline = b.maxDeadline;
            }
            if (newDeadline > b.deadline) {
                b.deadline = newDeadline;
                emit DeadlineExtended(bountyId, newDeadline);
            }
        }
    }

    /// @notice El verificador liquida el bounty.
    function settle(uint256 bountyId, address developer, bytes32 evidence) external {
        Bounty storage b = bounties[bountyId];
        require(msg.sender == b.verifier, "OnlyVerifier");
        require(!b.settled, "AlreadySettled");
        require(block.timestamp <= b.deadline, "TooLate");
        b.settled = true;
        uint256 fee = (b.amount * feeBps) / 10_000;
        payable(feeRecipient).transfer(fee);
        payable(developer).transfer(b.amount - fee);
        emit BountySettled(bountyId, developer, evidence);
    }

    /// @notice El financiador reclama su dinero si el plazo expiró sin liquidación.
    function refund(uint256 bountyId) external {
        Bounty storage b = bounties[bountyId];
        require(msg.sender == b.funder, "OnlyFunder");
        require(!b.settled, "AlreadySettled");
        require(block.timestamp > b.deadline, "TooEarly");
        uint256 amount = b.amount;
        b.amount = 0;
        payable(b.funder).transfer(amount);
        emit BountyRefunded(bountyId);
    }

    /// @notice Obtiene la información del bounty.
    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return bounties[bountyId];
    }
}
