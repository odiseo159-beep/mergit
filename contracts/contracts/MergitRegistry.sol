// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  MergitRegistry — quién es quién entre GitHub y la cadena
/// @notice Un desarrollador reclama su login de GitHub desde su propia wallet y deja
///         apuntada la prueba: una URL que solo esa cuenta de GitHub pudo publicar.
///         El agente lee este registro antes de pagar, en vez de un archivo del
///         repositorio, y cualquiera puede rehacer la comprobación.
/// @dev    El contrato no verifica la prueba: no puede: no habla con GitHub. Lo que
///         hace es fijar la afirmación, con su autor, su hora y su prueba, para que
///         verificarla sea barato y desmentirla deje rastro. Quien paga decide si esa
///         prueba le basta; el agente de Mergit exige que la URL pertenezca al login
///         y contenga la dirección que reclama.
///
///         No hay dueño, ni pausa, ni actualización. Una wallet tiene como mucho un
///         login y un login como mucho una wallet, así que el índice inverso sirve
///         como perfil: de una dirección se llega a su login, y de ahí a sus pagos.
contract MergitRegistry {
    struct Claim {
        address wallet; // quién reclamó el login
        uint64 claimedAt; // cuándo, para poder exigir antigüedad
        string login; // el login tal como se escribió
        string proofURI; // dónde está la prueba (gist, repo de perfil, etc.)
    }

    /// @dev La clave es keccak256 del login en minúsculas: GitHub no distingue mayúsculas.
    mapping(bytes32 => Claim) private _claims;

    /// @notice El login que reclamó una wallet. Vacío si no reclamó ninguno.
    mapping(address => bytes32) public loginOf;

    uint256 public totalClaims;

    event Claimed(bytes32 indexed loginHash, address indexed wallet, string login, string proofURI);
    event ProofUpdated(bytes32 indexed loginHash, address indexed wallet, string proofURI);
    event Released(bytes32 indexed loginHash, address indexed wallet);

    error EmptyLogin();
    error EmptyProof();
    error LoginTaken(address wallet);
    error WalletBusy(bytes32 loginHash);
    error NotTheClaimant();
    error NothingToRelease();

    // ─────────────────────────────── Reclamar ────────────────────────────

    /// @notice Reclama un login de GitHub para quien firma la transacción.
    /// @param login    El login, tal como aparece en GitHub.
    /// @param proofURI URL de una publicación de esa cuenta que contenga esta dirección.
    function claim(string calldata login, string calldata proofURI) external returns (bytes32 loginHash) {
        if (bytes(login).length == 0) revert EmptyLogin();
        if (bytes(proofURI).length == 0) revert EmptyProof();

        loginHash = hashLogin(login);

        address taken = _claims[loginHash].wallet;
        if (taken != address(0) && taken != msg.sender) revert LoginTaken(taken);

        bytes32 previous = loginOf[msg.sender];
        if (previous != bytes32(0) && previous != loginHash) revert WalletBusy(previous);

        if (taken == address(0)) {
            _claims[loginHash] = Claim(msg.sender, uint64(block.timestamp), login, proofURI);
            loginOf[msg.sender] = loginHash;
            totalClaims += 1;
            emit Claimed(loginHash, msg.sender, login, proofURI);
        } else {
            // El mismo dueño actualiza su prueba sin perder la antigüedad.
            _claims[loginHash].proofURI = proofURI;
            emit ProofUpdated(loginHash, msg.sender, proofURI);
        }
    }

    /// @notice Suelta el login para que otra wallet pueda reclamarlo.
    /// @dev    Hace falta cuando alguien pierde el acceso a su wallet: sin esto, el
    ///         login quedaría atrapado para siempre.
    function release() external {
        bytes32 loginHash = loginOf[msg.sender];
        if (loginHash == bytes32(0)) revert NothingToRelease();
        if (_claims[loginHash].wallet != msg.sender) revert NotTheClaimant();

        delete _claims[loginHash];
        delete loginOf[msg.sender];
        totalClaims -= 1;
        emit Released(loginHash, msg.sender);
    }

    // ─────────────────────────────── Lecturas ────────────────────────────

    /// @notice La wallet registrada para un login, o la dirección cero.
    function walletOf(string calldata login) external view returns (address) {
        return _claims[hashLogin(login)].wallet;
    }

    /// @notice Igual que `walletOf`, cuando ya se tiene el hash calculado.
    function walletOfHash(bytes32 loginHash) external view returns (address) {
        return _claims[loginHash].wallet;
    }

    /// @notice La reclamación completa: wallet, fecha, login y prueba.
    function claimOf(string calldata login) external view returns (Claim memory) {
        return _claims[hashLogin(login)];
    }

    function claimOfHash(bytes32 loginHash) external view returns (Claim memory) {
        return _claims[loginHash];
    }

    /// @notice El hash con el que se indexa un login: minúsculas y keccak256.
    /// @dev    GitHub trata `Odiseo` y `odiseo` como la misma cuenta. Pasar a
    ///         minúsculas aquí evita que dos personas reclamen el mismo login.
    function hashLogin(string memory login) public pure returns (bytes32) {
        bytes memory b = bytes(login);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) b[i] = bytes1(uint8(b[i]) + 32);
        }
        return keccak256(b);
    }
}
