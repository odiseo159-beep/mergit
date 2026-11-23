// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IEscrowV4 {
    function postBounty(
        address verifier,
        uint64 deadline,
        uint64 maxDeadline,
        uint32 challengeWindow,
        string calldata metadataURI
    ) external payable returns (uint256);

    function refund(uint256 bountyId) external;

    function withdrawTo(address to) external;
}

/// @title  ReceptorHostil — contrato auxiliar de pruebas para la entrega de ETH de la v4
/// @notice Puede ser desarrollador, financiador o receptor de comisión, y decide cómo
///         se porta cuando le llega ETH.
contract ReceptorHostil {
    enum Modo {
        Acepta,
        Rechaza,
        QuemaGas,
        BombaRetorno,
        Billetera, // escribe y emite, como una billetera de contrato
        Reentra
    }

    event Recibido(address indexed de, uint256 monto);

    IEscrowV4 public escrow;
    Modo public modo;
    uint256 public totalRecibido;
    uint256 public escrituras;
    bool public reentradaExitosa;

    function configurar(IEscrowV4 escrow_, Modo modo_) external {
        escrow = escrow_;
        modo = modo_;
    }

    function publicar(address verificador, uint64 plazo, uint32 ventana) external payable returns (uint256) {
        return escrow.postBounty{value: msg.value}(verificador, plazo, plazo, ventana, "repo#1");
    }

    function reembolsar(uint256 bountyId) external {
        escrow.refund(bountyId);
    }

    function retirar(address destino) external {
        escrow.withdrawTo(destino);
    }

    receive() external payable {
        Modo m = modo;

        if (m == Modo.Rechaza) revert("no recibo ETH");
        if (m == Modo.QuemaGas) {
            while (true) {
                escrituras++;
            }
        }
        if (m == Modo.BombaRetorno) {
            assembly {
                revert(0, 60000)
            }
        }
        if (m == Modo.Billetera) {
            escrituras++;
            emit Recibido(msg.sender, msg.value);
        }
        if (m == Modo.Reentra) {
            try escrow.withdrawTo(address(this)) {
                reentradaExitosa = true;
            } catch {}
        }

        totalRecibido += msg.value;
    }
}
