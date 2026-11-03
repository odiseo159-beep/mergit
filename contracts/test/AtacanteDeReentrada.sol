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
/// @notice Contrato de prueba para el bounty #2: ataca `settle` y `refund`
///         mientras recibe ETH, desde dentro de la misma transferencia.
/// @dev    El atacante es verificador Y desarrollador a la vez: así sus
///         callbacks pasan los checks de rol (msg.sender == verifier) y lo
///         único que puede detenerlos es la guardia de reentrada. Sin guardia,
///         el escenario `ReintentarOtroSettle` pagaría dos veces — ese es el
///         ataque de verdad, no solo el reintento del mismo bounty.
///         Vive en test/ a propósito: es un arnés, no producción.
contract AtacanteDeReentrada {
    enum Ataque {
        Ninguno,
        ReintentarMismoSettle,   // dentro del payout: re-liquidar el MISMO bounty
        ReintentarOtroSettle,    // dentro del payout: liquidar un bounty DISTINTO
        ReintentarRefund,        // dentro del refund: reembolsar el MISMO bounty otra vez
        SettleDuranteRefund      // dentro del refund: colar un settle de otro bounty
    }

    IMergitEscrowLite public escrow;
    Ataque public ataque;
    uint256 public idMismo;
    uint256 public idOtro;

    bool public reentradaIntentada;
    bool public reentradaBloqueada;
    bool public reentradaPas;
    /// @dev Selector del revert del último intento: prueba que frenó la
    ///      guardia (`Reentrancy()`), no un check de estado casual.
    bytes4 public ultimoSelector;

    event ReentradaEjecutada(uint8 ataque, bool bloqueada);

    constructor(address escrow_) {
        escrow = IMergitEscrowLite(escrow_);
    }

    function preparar(Ataque ataque_, uint256 idMismo_, uint256 idOtro_) external {
        ataque = ataque_;
        idMismo = idMismo_;
        idOtro = idOtro_;
    }

    /// @notice Inicia el settle desde el contrato (es el verifier designado).
    function ejecutarSettle(uint256 bountyId, bytes32 evidencia) external {
        escrow.settle(bountyId, address(this), evidencia);
    }

    /// @notice Inicia el reembolso él mismo (también puede ser el funder).
    function ejecutarRefund(uint256 bountyId) external {
        escrow.refund(bountyId);
    }
    /// @notice El atacante publica su propio bounty: así es funder a la vez,
    ///         y un `refund` sobre él transfiere ETH al atacante en medio de
    ///         la ejecución — el momento exacto donde vive la reentrada.
    function ejecutarPost(uint64 deadline) external payable returns (uint256 bountyId) {
        bountyId = escrow.postBounty{value: msg.value}(address(this), deadline, "ataque-reentrada");
    }


    receive() external payable {
        if (ataque == Ataque.Ninguno) return;
        reentradaIntentada = true;
        bool bloqueada;

        if (ataque == Ataque.ReintentarMismoSettle) {
            try escrow.settle(idMismo, address(this), "reintento-mismo") {
                bloqueada = false;
            } catch (bytes memory r) {
                bloqueada = true;
                ultimoSelector = r.length >= 4 ? bytes4(r) : bytes4(0);
            }
        } else if (ataque == Ataque.ReintentarOtroSettle) {
            try escrow.settle(idOtro, address(this), "reintento-otro") {
                bloqueada = false;
            } catch (bytes memory r) {
                bloqueada = true;
                ultimoSelector = r.length >= 4 ? bytes4(r) : bytes4(0);
            }
        } else if (ataque == Ataque.ReintentarRefund) {
            try escrow.refund(idMismo) {
                bloqueada = false;
            } catch (bytes memory r) {
                bloqueada = true;
                ultimoSelector = r.length >= 4 ? bytes4(r) : bytes4(0);
            }
        } else {
            // SettleDuranteRefund
            try escrow.settle(idOtro, address(this), "settle-durante-refund") {
                bloqueada = false;
            } catch (bytes memory r) {
                bloqueada = true;
                ultimoSelector = r.length >= 4 ? bytes4(r) : bytes4(0);
            }
        }

        reentradaBloqueada = bloqueada;
        reentradaPas = !bloqueada;
        emit ReentradaEjecutada(uint8(ataque), bloqueada);
    }
}
