import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, keccak256, toHex } from "viem";

const FEE_BPS = 150n; // 1.5%
const BPS = 10_000n;
const AMOUNT = parseEther("0.01");
const WINDOW = 3600; // una hora
const EVIDENCE = keccak256(toHex("mergit-demo#2"));

describe("MergitEscrowV2", async () => {
  const { viem, networkHelpers } = await network.connect();

  let escrow, funder, verifier, developer, stranger, feeRecipient, publicClient;

  const deadline = async (secondsAhead = 86_400) => {
    const block = await publicClient.getBlock();
    return BigInt(block.timestamp) + BigInt(secondsAhead);
  };

  const post = async (window = WINDOW) =>
    escrow.write.postBounty([verifier.account.address, await deadline(), window, "repo#1"], { value: AMOUNT });

  beforeEach(async () => {
    [funder, verifier, developer, stranger, feeRecipient] = await viem.getWalletClients();
    publicClient = await viem.getPublicClient();
    escrow = await viem.deployContract("MergitEscrowV2", [Number(FEE_BPS), feeRecipient.account.address]);
  });

  const status = async (id) => (await escrow.read.getBounty([id])).status; // 1 Open, 2 Pending, 3 Settled, 4 Refunded

  // ── sin ventana: la v1 tal cual ───────────────────────────────

  it("sin ventana, el pago sale en el mismo bloque que la verificación", async () => {
    await post(0);
    const before = await publicClient.getBalance({ address: developer.account.address });

    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    const after = await publicClient.getBalance({ address: developer.account.address });
    assert.equal(after - before, AMOUNT - (AMOUNT * FEE_BPS) / BPS);
    assert.equal(await status(1n), 3);
  });

  // ── con ventana ───────────────────────────────────────────────

  it("con ventana, la liquidación deja el pago pendiente, no pagado", async () => {
    await post();
    const before = await publicClient.getBalance({ address: developer.account.address });

    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    assert.equal(await status(1n), 2);
    assert.equal(await publicClient.getBalance({ address: developer.account.address }), before);

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.developer.toLowerCase(), developer.account.address.toLowerCase());
    assert.equal(b.evidenceHash, EVIDENCE);
    assert.ok(b.claimableAt > 0n);
  });

  it("anuncia la propuesta con la hora en que podrá cobrarse", async () => {
    await post();
    const tx = await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const [event] = await escrow.getEvents.SettlementProposed();
    assert.equal(event.args.developer.toLowerCase(), developer.account.address.toLowerCase());
    assert.equal(event.args.evidenceHash, EVIDENCE);
  });

  it("no se puede finalizar antes de tiempo", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    await assert.rejects(escrow.write.finalize([1n]), /TooEarly/);
  });

  it("pasada la ventana, cualquiera puede soltar el pago", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await networkHelpers.time.increase(WINDOW + 1);

    const before = await publicClient.getBalance({ address: developer.account.address });
    await escrow.write.finalize([1n], { account: stranger.account });

    const after = await publicClient.getBalance({ address: developer.account.address });
    assert.equal(after - before, AMOUNT - (AMOUNT * FEE_BPS) / BPS);
    assert.equal(await status(1n), 3);
  });

  it("el pago pendiente sobrevive al plazo del bounty", async () => {
    const short = 120;
    await escrow.write.postBounty([verifier.account.address, await deadline(short), WINDOW, "repo#1"], { value: AMOUNT });
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    await networkHelpers.time.increase(WINDOW + short + 10); // vence el plazo y la ventana

    await assert.rejects(escrow.write.refund([1n]), /NotOpen/);
    await escrow.write.finalize([1n]);
    assert.equal(await status(1n), 3);
  });

  // ── la objeción ───────────────────────────────────────────────

  it("el financiador objeta y el bounty vuelve a estar abierto", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    await escrow.write.challenge([1n]);

    assert.equal(await status(1n), 1);
    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.developer, "0x0000000000000000000000000000000000000000");
    assert.equal(b.challenged, true);
  });

  it("tras la objeción, la siguiente liquidación paga en el acto", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await escrow.write.challenge([1n]);

    const before = await publicClient.getBalance({ address: stranger.account.address });
    await escrow.write.settle([1n, stranger.account.address, EVIDENCE], { account: verifier.account });

    const after = await publicClient.getBalance({ address: stranger.account.address });
    assert.equal(after - before, AMOUNT - (AMOUNT * FEE_BPS) / BPS);
    assert.equal(await status(1n), 3);
  });

  it("la objeción es una sola por bounty", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await escrow.write.challenge([1n]);
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    // la segunda liquidación pagó, así que ya no hay nada que objetar
    await assert.rejects(escrow.write.challenge([1n]), /NotPending/);
  });

  it("solo el financiador puede objetar", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    await assert.rejects(escrow.write.challenge([1n], { account: stranger.account }), /NotFunder/);
    await assert.rejects(escrow.write.challenge([1n], { account: verifier.account }), /NotFunder/);
  });

  it("no se puede objetar una vez cumplida la ventana", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await networkHelpers.time.increase(WINDOW + 1);

    await assert.rejects(escrow.write.challenge([1n]), /TooEarly/);
  });

  it("no se puede liquidar dos veces mientras hay un pago pendiente", async () => {
    await post();
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    await assert.rejects(
      escrow.write.settle([1n, stranger.account.address, EVIDENCE], { account: verifier.account }),
      /NotOpen/,
    );
  });

  // ── límites heredados de la v1 ────────────────────────────────

  it("solo el verificador liquida", async () => {
    await post();
    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: stranger.account }),
      /NotVerifier/,
    );
  });

  it("rechaza una ventana mayor que el techo de 7 días", async () => {
    await assert.rejects(
      escrow.write.postBounty([verifier.account.address, await deadline(), 7 * 86_400 + 1, "repo#1"], { value: AMOUNT }),
      /WindowTooLong/,
    );
  });

  it("mantiene el techo de comisión del 5%", async () => {
    await assert.rejects(viem.deployContract("MergitEscrowV2", [501, feeRecipient.account.address]), /FeeTooHigh/);
  });

  it("el financiador recupera los fondos pasado el plazo sin trabajo", async () => {
    const short = 60;
    await escrow.write.postBounty([verifier.account.address, await deadline(short), WINDOW, "repo#1"], { value: AMOUNT });
    await networkHelpers.time.increase(short + 10);

    await escrow.write.refund([1n]);
    assert.equal(await status(1n), 4);
  });

  it("la comisión va al destinatario fijado en el constructor", async () => {
    await post(0);
    const before = await publicClient.getBalance({ address: feeRecipient.account.address });
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });

    const after = await publicClient.getBalance({ address: feeRecipient.account.address });
    assert.equal(after - before, (AMOUNT * FEE_BPS) / BPS);
  });

  // ── carrera entre objeción y reembolso (Issue #1) ─────────────

  it("carrera: si el financiador objeta al borde del plazo, puede reembolsarse antes de reliquidar", async () => {
    // Bounty con plazo corto (120s) y ventana de objeción que lo cubre (180s)
    const shortDeadline = 120;
    const window = 180;
    await escrow.write.postBounty(
      [verifier.account.address, await deadline(shortDeadline), window, "repo#1"],
      { value: AMOUNT },
    );

    // 1. El verificador propone la liquidación: queda pendiente
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    assert.equal(await status(1n), 2); // Pending

    // 2. El tiempo avanza casi hasta el vencimiento del plazo (100s de 120s), dentro de la ventana de objeción
    await networkHelpers.time.increase(100);

    // 3. El financiador objeta al borde del plazo: el bounty vuelve a estar Open con challenged = true
    await escrow.write.challenge([1n], { account: funder.account });
    assert.equal(await status(1n), 1); // Open
    const bChallenged = await escrow.read.getBounty([1n]);
    assert.equal(bChallenged.challenged, true);

    // 4. El tiempo pasa el deadline original (25s más -> 125s > 120s)
    await networkHelpers.time.increase(25);

    // 5. El financiador gana la carrera: pide el reembolso en cuanto vence el plazo
    const beforeFunder = await publicClient.getBalance({ address: funder.account.address });
    await escrow.write.refund([1n], { account: funder.account });
    assert.equal(await status(1n), 4); // Refunded
    const afterFunder = await publicClient.getBalance({ address: funder.account.address });
    assert.ok(afterFunder > beforeFunder);

    // 6. El verificador intenta volver a liquidar, pero ya es imposible (revierte por NotOpen)
    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account }),
      /NotOpen/,
    );
  });

  it("si el plazo vence tras la objeción y nadie reembolsa aún, el verificador no puede liquidar por DeadlinePassed", async () => {
    const shortDeadline = 120;
    const window = 180;
    await escrow.write.postBounty(
      [verifier.account.address, await deadline(shortDeadline), window, "repo#1"],
      { value: AMOUNT },
    );

    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    await networkHelpers.time.increase(100);
    await escrow.write.challenge([1n], { account: funder.account });

    // Pasa el plazo
    await networkHelpers.time.increase(25);

    // Si el verificador intenta liquidar antes del reembolso, revierte por plazo vencido
    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account }),
      /DeadlinePassed/,
    );

    // El financiador aún puede cobrar su reembolso
    await escrow.write.refund([1n], { account: funder.account });
    assert.equal(await status(1n), 4);
  });
});

