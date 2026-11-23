// La v4 existe por una sola razón: un pago aprobado no puede quedarse atascado.
// Estas pruebas van a quien intenta atascarlo. El resto del contrato lo cubre la
// suite de la v3, que corre también contra la v4.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, keccak256, toHex } from "viem";

const FEE_BPS = 150n;
const AMOUNT = parseEther("0.01");
const FEE = (AMOUNT * FEE_BPS) / 10_000n;
const PAYOUT = AMOUNT - FEE;
const EVIDENCE = keccak256(toHex("mergit-demo#2"));
const DIA = 86_400;
const VENTANA = 180;

const OPEN = 1;
const PENDING = 2;
const SETTLED = 3;
const REFUNDED = 4;

const MODO = { Acepta: 0, Rechaza: 1, QuemaGas: 2, BombaRetorno: 3, Billetera: 4, Reentra: 5 };

describe("MergitEscrowV4 · un pago no se atasca", async () => {
  const { viem, networkHelpers } = await network.connect();

  let escrow, funder, verifier, developer, stranger, feeRecipient, publicClient, receptor;

  const ahora = async () => Number((await publicClient.getBlock()).timestamp);
  const saldo = (address) => publicClient.getBalance({ address });
  const estado = async (id = 1n) => (await escrow.read.getBounty([id])).status;

  const post = async (ventana = VENTANA) => {
    const t = await ahora();
    return escrow.write.postBounty(
      [verifier.account.address, BigInt(t + 7 * DIA), BigInt(t + 7 * DIA), ventana, "repo#1"],
      { value: AMOUNT },
    );
  };
  const proponer = (destino, id = 1n) =>
    escrow.write.settle([id, destino, EVIDENCE], { account: verifier.account });
  const pasarVentana = () => networkHelpers.time.increase(VENTANA + 1);

  beforeEach(async () => {
    [funder, verifier, developer, stranger, feeRecipient] = await viem.getWalletClients();
    publicClient = await viem.getPublicClient();
    escrow = await viem.deployContract("MergitEscrowV4", [Number(FEE_BPS), feeRecipient.account.address]);
    receptor = await viem.deployContract("ReceptorHostil");
    await receptor.write.configurar([escrow.address, MODO.Rechaza]);
  });

  it("declara su versión", async () => {
    assert.equal(await escrow.read.VERSION(), 4);
  });

  // ── el fallo que encontró Aegis ──────────────────────────────

  it("con ventana, un desarrollador que rechaza ETH ya no bloquea los fondos", async () => {
    await post();
    await proponer(receptor.address);
    await pasarVentana();

    const antesFee = await saldo(feeRecipient.account.address);
    await escrow.write.finalize([1n], { account: stranger.account });

    assert.equal(await estado(), SETTLED);
    assert.equal(await escrow.read.owed([receptor.address]), PAYOUT);
    assert.equal((await saldo(feeRecipient.account.address)) - antesFee, FEE);
    assert.equal(await saldo(escrow.address), PAYOUT);

    const ev = await escrow.getEvents.PaymentCredited();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].args.bountyId, 1n);
    assert.equal(ev[0].args.amount, PAYOUT);
  });

  it("lo acreditado se retira a otra dirección", async () => {
    await post();
    await proponer(receptor.address);
    await pasarVentana();
    await escrow.write.finalize([1n]);

    const antes = await saldo(developer.account.address);
    await receptor.write.retirar([developer.account.address]);

    assert.equal((await saldo(developer.account.address)) - antes, PAYOUT);
    assert.equal(await escrow.read.owed([receptor.address]), 0n);
    assert.equal(await saldo(escrow.address), 0n);
  });

  for (const nombre of ["QuemaGas", "BombaRetorno"]) {
    it(`${nombre}: no puede hacer revertir finalize`, async () => {
      await receptor.write.configurar([escrow.address, MODO[nombre]]);
      await post();
      await proponer(receptor.address);
      await pasarVentana();

      const hash = await escrow.write.finalize([1n], { gas: 500_000n });
      const r = await publicClient.waitForTransactionReceipt({ hash });

      assert.equal(r.status, "success");
      assert.equal(await estado(), SETTLED);
      assert.equal(await escrow.read.owed([receptor.address]), PAYOUT);
    });
  }

  // ── sin ventana se conserva el comportamiento de la v1 ───────

  it("sin ventana, settle revierte y el bounty sigue abierto", async () => {
    await post(0);
    await assert.rejects(proponer(receptor.address), /TransferFailed/);
    assert.equal(await estado(), OPEN);
    assert.equal(await escrow.read.owed([receptor.address]), 0n);
  });

  it("sin ventana, el verificador puede corregir la dirección", async () => {
    await post(0);
    await assert.rejects(proponer(receptor.address), /TransferFailed/);

    const antes = await saldo(developer.account.address);
    await proponer(developer.account.address);

    assert.equal(await estado(), SETTLED);
    assert.equal((await saldo(developer.account.address)) - antes, PAYOUT);
  });

  it("sin ventana, el financiador conserva su reembolso", async () => {
    await post(0);
    await assert.rejects(proponer(receptor.address), /TransferFailed/);
    await networkHelpers.time.increase(8 * DIA);
    await escrow.write.refund([1n]);
    assert.equal(await estado(), REFUNDED);
    assert.equal(await saldo(escrow.address), 0n);
  });

  it("tras una objeción, settle tampoco acredita: revierte y se puede corregir", async () => {
    await post();
    await proponer(developer.account.address);
    await escrow.write.challenge([1n]);

    await assert.rejects(proponer(receptor.address), /TransferFailed/);
    assert.equal(await estado(), OPEN);
    await proponer(developer.account.address);
    assert.equal(await estado(), SETTLED);
  });

  // ── el gas de quien llama ────────────────────────────────────

  it("nadie puede forzar el crédito llamando con poco gas", async () => {
    await post();
    await proponer(developer.account.address);
    await pasarVentana();

    for (const gas of [60_000n, 100_000n, 150_000n, 170_000n]) {
      await assert.rejects(escrow.write.finalize([1n], { account: stranger.account, gas }));
      assert.equal(await estado(), PENDING);
    }

    const antes = await saldo(developer.account.address);
    await escrow.write.finalize([1n], { account: stranger.account, gas: 400_000n });

    assert.equal(await estado(), SETTLED);
    assert.equal((await saldo(developer.account.address)) - antes, PAYOUT);
    assert.equal(await escrow.read.owed([developer.account.address]), 0n);
  });

  it("una billetera de contrato cobra directo, sin retirar", async () => {
    await receptor.write.configurar([escrow.address, MODO.Billetera]);
    await post();
    await proponer(receptor.address);
    await pasarVentana();
    await escrow.write.finalize([1n]);

    assert.equal(await receptor.read.totalRecibido(), PAYOUT);
    assert.equal(await receptor.read.escrituras(), 1n);
    assert.equal(await escrow.read.owed([receptor.address]), 0n);
  });

  // ── comisión y reembolso ─────────────────────────────────────

  it("un receptor de comisión que rechaza ETH no bloquea el pago", async () => {
    const conFee = await viem.deployContract("MergitEscrowV4", [Number(FEE_BPS), receptor.address]);
    await receptor.write.configurar([conFee.address, MODO.Rechaza]);
    const t = await ahora();
    await conFee.write.postBounty(
      [verifier.account.address, BigInt(t + 7 * DIA), BigInt(t + 7 * DIA), 0, "repo#1"],
      { value: AMOUNT },
    );

    const antes = await saldo(developer.account.address);
    await conFee.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    assert.equal((await saldo(developer.account.address)) - antes, PAYOUT);
    assert.equal(await conFee.read.owed([receptor.address]), FEE);
  });

  it("un financiador que rechaza ETH recibe su reembolso como crédito", async () => {
    await receptor.write.configurar([escrow.address, MODO.Acepta]);
    const t = await ahora();
    await receptor.write.publicar([verifier.account.address, BigInt(t + DIA), 0], { value: AMOUNT });
    await receptor.write.configurar([escrow.address, MODO.Rechaza]);

    await networkHelpers.time.increase(2 * DIA);
    await receptor.write.reembolsar([1n]);

    assert.equal(await estado(), REFUNDED);
    assert.equal(await escrow.read.owed([receptor.address]), AMOUNT);

    const antes = await saldo(stranger.account.address);
    await receptor.write.retirar([stranger.account.address]);
    assert.equal((await saldo(stranger.account.address)) - antes, AMOUNT);
  });

  // ── withdrawTo ───────────────────────────────────────────────

  const acreditar = async () => {
    await post();
    await proponer(receptor.address);
    await pasarVentana();
    await escrow.write.finalize([1n]);
  };

  it("no se puede retirar dos veces ni reentrar", async () => {
    await acreditar();
    await receptor.write.configurar([escrow.address, MODO.Reentra]);
    await receptor.write.retirar([receptor.address]);

    assert.equal(await receptor.read.reentradaExitosa(), false);
    assert.equal(await receptor.read.totalRecibido(), PAYOUT);
    assert.equal(await saldo(escrow.address), 0n);
    await assert.rejects(receptor.write.retirar([receptor.address]), /NothingOwed/);
  });

  it("solo retira el dueño del crédito", async () => {
    await acreditar();
    await assert.rejects(
      escrow.write.withdrawTo([stranger.account.address], { account: stranger.account }),
      /NothingOwed/,
    );
    assert.equal(await escrow.read.owed([receptor.address]), PAYOUT);
  });

  it("si el destino del retiro falla, el saldo sigue ahí", async () => {
    await acreditar();
    await assert.rejects(receptor.write.retirar([receptor.address]));
    assert.equal(await escrow.read.owed([receptor.address]), PAYOUT);

    await receptor.write.retirar([developer.account.address]);
    assert.equal(await escrow.read.owed([receptor.address]), 0n);
  });

  it("no acepta retirar a la dirección cero", async () => {
    await acreditar();
    await assert.rejects(
      receptor.write.retirar(["0x0000000000000000000000000000000000000000"]),
      /ZeroAddress/,
    );
  });

  it("el dinero cuadra: el escrow guarda justo lo acreditado", async () => {
    await post();
    await post();
    await proponer(receptor.address, 1n);
    await proponer(developer.account.address, 2n);
    await pasarVentana();
    await escrow.write.finalize([1n]);
    await escrow.write.finalize([2n]);

    assert.equal(await saldo(escrow.address), await escrow.read.owed([receptor.address]));
  });
});
