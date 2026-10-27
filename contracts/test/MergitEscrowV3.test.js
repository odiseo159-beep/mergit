// Lo que añade la v3 es `extend`, y lo que importa de `extend` es lo que NO
// deja hacer. Estas pruebas van casi todas a los límites, no al camino feliz.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, keccak256, toHex } from "viem";

const FEE_BPS = 150n;
const AMOUNT = parseEther("0.01");
const EVIDENCE = keccak256(toHex("mergit-demo#2"));
const DIA = 86_400;

describe("MergitEscrowV3 · extender el plazo", async () => {
  const { viem, networkHelpers } = await network.connect();

  let escrow, funder, verifier, developer, stranger, feeRecipient, publicClient;

  const ahora = async () => Number((await publicClient.getBlock()).timestamp);

  /** Publica con plazo a `dias` y tope a `topeDias`. Tope igual = sin extensión. */
  const post = async (dias = 1, topeDias = 7, window = 0) => {
    const t = await ahora();
    return escrow.write.postBounty(
      [verifier.account.address, BigInt(t + dias * DIA), BigInt(t + topeDias * DIA), window, "repo#1"],
      { value: AMOUNT },
    );
  };

  const plazo = async (id) => Number((await escrow.read.getBounty([id])).deadline);
  const tope = async (id) => Number((await escrow.read.getBounty([id])).maxDeadline);

  beforeEach(async () => {
    [funder, verifier, developer, stranger, feeRecipient] = await viem.getWalletClients();
    publicClient = await viem.getPublicClient();
    escrow = await viem.deployContract("MergitEscrowV3", [Number(FEE_BPS), feeRecipient.account.address]);
  });

  // ── lo que sí ────────────────────────────────────────────────

  it("el financiador mueve el plazo hacia adelante", async () => {
    await post(1, 7);
    const antes = await plazo(1n);
    await escrow.write.extend([1n, BigInt(antes + 3 * DIA)]);
    assert.equal(await plazo(1n), antes + 3 * DIA);
  });

  it("el verificador puede extender hasta el tope, que es lo que deja automatizarlo", async () => {
    await post(1, 7);
    const t = await tope(1n);
    await escrow.write.extend([1n, BigInt(t)], { account: verifier.account });
    assert.equal(await plazo(1n), t);
  });

  it("un plazo extendido deja liquidar lo que antes ya no se podía", async () => {
    await post(1, 7);
    // se pasa el plazo original: sin extender, settle revertiría
    await networkHelpers.time.increase(2 * DIA);
    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account }),
      /DeadlinePassed/,
    );

    const t = await ahora();
    await escrow.write.extend([1n, BigInt(t + 3 * DIA)]);
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    assert.equal((await escrow.read.getBounty([1n])).status, 3); // Settled
  });

  it("el financiador puede pasarse del tope, y el tope sube con él", async () => {
    await post(1, 2);
    const t = await ahora();
    await escrow.write.extend([1n, BigInt(t + 30 * DIA)]);
    assert.equal(await tope(1n), t + 30 * DIA);
  });

  // ── lo que no ────────────────────────────────────────────────

  it("nadie puede acortar el plazo, ni el financiador", async () => {
    await post(5, 9);
    const antes = await plazo(1n);
    await assert.rejects(escrow.write.extend([1n, BigInt(antes - DIA)]), /DeadlineNotLater/);
    await assert.rejects(escrow.write.extend([1n, BigInt(antes)]), /DeadlineNotLater/);
  });

  it("el verificador no pasa del tope que fijó el financiador", async () => {
    await post(1, 3);
    const t = await tope(1n);
    await assert.rejects(
      escrow.write.extend([1n, BigInt(t + 1)], { account: verifier.account }),
      /BeyondMaxDeadline/,
    );
  });

  it("con el tope igual al plazo, el verificador no puede mover nada", async () => {
    await post(1, 1);
    const p = await plazo(1n);
    await assert.rejects(
      escrow.write.extend([1n, BigInt(p + 1)], { account: verifier.account }),
      /BeyondMaxDeadline/,
    );
    // el financiador sí, siempre
    await escrow.write.extend([1n, BigInt(p + DIA)]);
    assert.equal(await plazo(1n), p + DIA);
  });

  it("un desconocido no toca el plazo", async () => {
    await post(1, 7);
    const p = await plazo(1n);
    await assert.rejects(
      escrow.write.extend([1n, BigInt(p + DIA)], { account: stranger.account }),
      /NotFunderNorVerifier/,
    );
  });

  it("no se extiende un bounty que ya se pagó", async () => {
    await post(1, 7, 0);
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    const p = await plazo(1n);
    await assert.rejects(escrow.write.extend([1n, BigInt(p + DIA)]), /NotOpen/);
  });

  it("no se extiende un bounty que ya se devolvió", async () => {
    await post(1, 7);
    await networkHelpers.time.increase(2 * DIA);
    await escrow.write.refund([1n]);
    const p = await plazo(1n);
    await assert.rejects(escrow.write.extend([1n, BigInt(p + DIA)]), /NotOpen/);
  });

  it("no se extiende un bounty con el pago ya propuesto: finalize no mira el reloj", async () => {
    await post(1, 7, 3600);
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
    assert.equal((await escrow.read.getBounty([1n])).status, 2); // Pending
    const p = await plazo(1n);
    await assert.rejects(escrow.write.extend([1n, BigInt(p + DIA)]), /NotOpen/);
  });

  it("no se extiende un bounty que no existe", async () => {
    await assert.rejects(escrow.write.extend([99n, BigInt(await ahora() + DIA)]), /UnknownBounty/);
  });

  // ── al publicar ──────────────────────────────────────────────

  it("el tope no puede quedar por detrás del plazo", async () => {
    const t = await ahora();
    await assert.rejects(
      escrow.write.postBounty(
        [verifier.account.address, BigInt(t + 5 * DIA), BigInt(t + DIA), 0, "repo#1"],
        { value: AMOUNT },
      ),
      /DeadlineNotLater/,
    );
  });

  it("extender no mueve el dinero ni el destinatario", async () => {
    await post(1, 7);
    const antes = await escrow.read.getBounty([1n]);
    await escrow.write.extend([1n, BigInt(await plazo(1n) + DIA)]);
    const luego = await escrow.read.getBounty([1n]);
    assert.equal(luego.amount, antes.amount);
    assert.equal(luego.funder, antes.funder);
    assert.equal(luego.verifier, antes.verifier);
    assert.equal(luego.developer, antes.developer);
  });

  it("el evento dice quién lo movió y desde dónde", async () => {
    await post(1, 7);
    const antes = await plazo(1n);
    const hash = await escrow.write.extend([1n, BigInt(antes + DIA)]);
    await publicClient.waitForTransactionReceipt({ hash });
    const ev = await escrow.getEvents.DeadlineExtended();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].args.by.toLowerCase(), funder.account.address.toLowerCase());
    assert.equal(Number(ev[0].args.previousDeadline), antes);
    assert.equal(Number(ev[0].args.newDeadline), antes + DIA);
  });
});
