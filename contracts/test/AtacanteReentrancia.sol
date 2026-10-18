// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../contracts/MergitEscrow.sol";

/// @title AtacanteReentrancia
/// @notice Contrato auxiliar de prueba para verificar que la guardia nonReentrant
///         de MergitEscrow detiene ataques de reentrada al recibir pagos en settle() o refund().
contract AtacanteReentrancia {
    MergitEscrow public immutable escrow;

    enum TipoAtaque {
        Inactivo,
        ReentrarSettleMismo,
        ReentrarSettleOtro,
        ReentrarRefundMismo,
        ReentrarRefundOtro
    }

    TipoAtaque public tipoAtaque;
    uint256 public bountyObjetivo;
    address public desarrolladorObjetivo;
    bytes32 public evidenciaObjetivo;

    uint256 public intentosAtaque;
    bytes public ultimoErrorRevert;
    bool public ataqueRevertido;

    constructor(address payable escrow_) {
        escrow = MergitEscrow(escrow_);
    }

    /// @notice Permite al atacante publicar un bounty para ser el funder y auditar refund().
    function publicarBounty(address verifier, uint64 deadline, string calldata metadataURI)
        external
        payable
        returns (uint256)
    {
        return escrow.postBounty{value: msg.value}(verifier, deadline, metadataURI);
    }

    /// @notice Permite al atacante solicitar el reembolso de un bounty donde es el funder.
    function reclamarReembolso(uint256 bountyId) external {
        escrow.refund(bountyId);
    }

    /// @notice Configura el objetivo y la llamada que intentará ejecutar al recibir ETH.
    function prepararAtaque(
        TipoAtaque tipo_,
        uint256 bountyId_,
        address dev_,
        bytes32 ev_
    ) external {
        tipoAtaque = tipo_;
        bountyObjetivo = bountyId_;
        desarrolladorObjetivo = dev_;
        evidenciaObjetivo = ev_;
        intentosAtaque = 0;
        ataqueRevertido = false;
        ultimoErrorRevert = "";
    }

    /// @notice Gancho de recepción de ETH: aquí se produce el intento de reentrada.
    receive() external payable {
        if (tipoAtaque == TipoAtaque.Inactivo) return;

        TipoAtaque accion = tipoAtaque;
        tipoAtaque = TipoAtaque.Inactivo; // Prevenir recursión infinita
        intentosAtaque++;

        bytes memory llamada;
        if (accion == TipoAtaque.ReentrarSettleMismo || accion == TipoAtaque.ReentrarSettleOtro) {
            llamada = abi.encodeWithSelector(
                MergitEscrow.settle.selector,
                bountyObjetivo,
                desarrolladorObjetivo,
                evidenciaObjetivo
            );
        } else if (accion == TipoAtaque.ReentrarRefundMismo || accion == TipoAtaque.ReentrarRefundOtro) {
            llamada = abi.encodeWithSelector(
                MergitEscrow.refund.selector,
                bountyObjetivo
            );
        }

        (bool exito, bytes memory datosRetorno) = address(escrow).call(llamada);
        if (!exito) {
            ataqueRevertido = true;
            ultimoErrorRevert = datosRetorno;
        }
    }
}
