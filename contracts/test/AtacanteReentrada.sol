// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Lo mínimo de MergitEscrow que necesita el atacante.
interface IMergitEscrow {
    function postBounty(address verifier, uint64 deadline, string calldata metadataURI)
        external
        payable
        returns (uint256 bountyId);

    function settle(uint256 bountyId, address developer, bytes32 evidenceHash) external;

    function refund(uint256 bountyId) external;
}

/// @title  AtacanteReentrada — solo para tests
/// @notice Un contrato que puede ser financiador, verificador y desarrollador a la vez,
///         y que al recibir ETH vuelve a llamar al escrow. Así cada check de rol de la
///         llamada reentrante se cumple y lo único que puede frenarla es la guardia.
/// @dev    La llamada reentrante va por `call` y su resultado se guarda en lugar de
///         propagarse: si se propagara, `_send` del escrow lo convertiría en
///         `PayoutFailed()` y no se podría ver qué la frenó.
contract AtacanteReentrada {
    enum Ataque {
        Ninguno,
        Liquidar, // reentra en settle(objetivo, este contrato, ...)
        Reembolsar // reentra en refund(objetivo)
    }

    IMergitEscrow public immutable escrow;

    Ataque public ataque;
    uint256 public objetivo;
    bool public propagar; // si es true, el receive revierte cuando la reentrada falla

    bool public intentado;
    bool public reentradaExitosa;
    bytes public datosRevert;
    uint256 public recibido;

    constructor(IMergitEscrow escrow_) {
        escrow = escrow_;
    }

    // ───────────────────────── Roles en el escrow ─────────────────────────

    function publicar(address verificador, uint64 plazo) external payable returns (uint256) {
        return escrow.postBounty{value: msg.value}(verificador, plazo, "atacante");
    }

    function liquidar(uint256 bountyId, bytes32 evidencia) external {
        escrow.settle(bountyId, address(this), evidencia);
    }

    function reembolsar(uint256 bountyId) external {
        escrow.refund(bountyId);
    }

    /// @notice Arma el ataque para el próximo ETH que entre.
    function armar(Ataque ataque_, uint256 objetivo_, bool propagar_) external {
        ataque = ataque_;
        objetivo = objetivo_;
        propagar = propagar_;
        intentado = false;
        reentradaExitosa = false;
        delete datosRevert;
    }

    // ───────────────────────────── El ataque ──────────────────────────────

    receive() external payable {
        recibido += msg.value;

        Ataque a = ataque;
        if (a == Ataque.Ninguno) return;
        ataque = Ataque.Ninguno; // un solo intento por pago, sin bucles

        bytes memory llamada = a == Ataque.Liquidar
            ? abi.encodeCall(IMergitEscrow.settle, (objetivo, address(this), bytes32(0)))
            : abi.encodeCall(IMergitEscrow.refund, (objetivo));

        intentado = true;
        (bool ok, bytes memory datos) = address(escrow).call(llamada);
        reentradaExitosa = ok;
        datosRevert = datos;

        if (!ok && propagar) {
            assembly {
                revert(add(datos, 32), mload(datos))
            }
        }
    }
}
