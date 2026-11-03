// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMergitEscrowLite {
    function postBounty(address verifier, uint64 deadline, string calldata metadataURI)
        external
        payable
        returns (uint256);
    function settle(uint256 bountyId, address developer, bytes32 evidenceHash) external;
    function refund(uint256 bountyId) external;
}

/// @title AtacanteDeReentrada
/// @notice Contrato auxiliar para auditar la guardia de reentrada en MergitEscrow (Issue #2, Bounty: #10).
/// @dev Intenta reentrar en `settle` y `refund` durante la recepción de ETH en `receive()`.
///      El contrato puede actuar como verificador, desarrollador y financiador simultáneamente
///      para validar que sea la guardia `nonReentrant` la que detenga la llamada y no un check de permisos.
contract AtacanteDeReentrada {
    enum ModoAtaque {
        Ninguno,
        SettleMismoBounty,       // Intenta re-liquidar el mismo bounty desde receive()
        SettleOtroBounty,        // Intenta liquidar un segundo bounty abierto durante el payout
        RefundMismoBounty,       // Intenta solicitar refund del mismo bounty durante la devolución
        SettleDuranteRefund      // Intenta forzar liquidación de otro bounty durante el reembolso
    }

    IMergitEscrowLite public immutable escrow;
    ModoAtaque public modoAtaque;
    uint256 public idBountyPrincipal;
    uint256 public idBountySecundario;

    bool public llamadaRecibida;
    bool public ataqueBloqueado;
    bytes4 public ultimoErrorSelector;

    event IntentoReentrada(ModoAtaque modo, bool bloqueado, bytes4 errorSelector);

    constructor(address escrow_) {
        escrow = IMergitEscrowLite(escrow_);
    }

    /// @notice Configura el vector de ataque antes de invocar la función objetivo en el escrow.
    function configurarAtaque(
        ModoAtaque nuevoModo,
        uint256 idPrincipal,
        uint256 idSecundario
    ) external {
        modoAtaque = nuevoModo;
        idBountyPrincipal = idPrincipal;
        idBountySecundario = idSecundario;
        llamadaRecibida = false;
        ataqueBloqueado = false;
        ultimoErrorSelector = bytes4(0);
    }

    /// @notice Publica un bounty financiado por el propio atacante para probar reentradas en refund.
    function publicarBounty(uint64 plazo) external payable returns (uint256) {
        return escrow.postBounty{value: msg.value}(address(this), plazo, "prueba-reentrada");
    }

    /// @notice Dispara la liquidación actuando como verificador.
    function iniciarSettle(uint256 bountyId, bytes32 evidencia) external {
        escrow.settle(bountyId, address(this), evidencia);
    }

    /// @notice Dispara el reembolso actuando como financiador.
    function iniciarRefund(uint256 bountyId) external {
        escrow.refund(bountyId);
    }

    /// @notice Hook ejecutado al recibir ETH desde el escrow.
    receive() external payable {
        if (modoAtaque == ModoAtaque.Ninguno) return;

        llamadaRecibida = true;
        bool bloqueado = false;
        bytes4 selector = bytes4(0);

        if (modoAtaque == ModoAtaque.SettleMismoBounty) {
            try escrow.settle(idBountyPrincipal, address(this), bytes32(0)) {
                bloqueado = false;
            } catch (bytes memory razon) {
                bloqueado = true;
                if (razon.length >= 4) {
                    selector = bytes4(razon);
                }
            }
        } else if (modoAtaque == ModoAtaque.SettleOtroBounty) {
            try escrow.settle(idBountySecundario, address(this), bytes32(0)) {
                bloqueado = false;
            } catch (bytes memory razon) {
                bloqueado = true;
                if (razon.length >= 4) {
                    selector = bytes4(razon);
                }
            }
        } else if (modoAtaque == ModoAtaque.RefundMismoBounty) {
            try escrow.refund(idBountyPrincipal) {
                bloqueado = false;
            } catch (bytes memory razon) {
                bloqueado = true;
                if (razon.length >= 4) {
                    selector = bytes4(razon);
                }
            }
        } else if (modoAtaque == ModoAtaque.SettleDuranteRefund) {
            try escrow.settle(idBountySecundario, address(this), bytes32(0)) {
                bloqueado = false;
            } catch (bytes memory razon) {
                bloqueado = true;
                if (razon.length >= 4) {
                    selector = bytes4(razon);
                }
            }
        }

        ataqueBloqueado = bloqueado;
        ultimoErrorSelector = selector;
        emit IntentoReentrada(modoAtaque, bloqueado, selector);
    }
}
