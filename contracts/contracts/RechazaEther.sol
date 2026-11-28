// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMergitEscrowV4 {
    function withdrawTo(address to) external;
}

/// @title  RechazaEther — un developer que no puede recibir ETH, para probar la v4 en vivo
/// @notice Existe para una sola prueba pública: que en MergitEscrowV4 un pago aprobado a
///         una dirección que rechaza ETH no se atasca. `finalize` lo acredita
///         (`PaymentCredited`) y el dueño de este contrato lo retira a otra dirección con
///         `withdrawTo`. Lo sugirió Aegis el 25-nov-2026 para que el arreglo de la v4
///         quede probado en la cadena y no solo en los tests.
/// @dev    No guarda fondos: rechaza todo ETH que le llega. Solo su dueño puede retirar.
contract RechazaEther {
    error NoEresElDueno();

    address public immutable dueno;
    IMergitEscrowV4 public immutable escrow;

    constructor(IMergitEscrowV4 escrow_) {
        dueno = msg.sender;
        escrow = escrow_;
    }

    /// @notice Saca de la v4 lo que se le acreditó a este contrato y lo manda a `destino`.
    function retirar(address destino) external {
        if (msg.sender != dueno) revert NoEresElDueno();
        escrow.withdrawTo(destino);
    }

    receive() external payable {
        revert("no recibo ETH");
    }
}
