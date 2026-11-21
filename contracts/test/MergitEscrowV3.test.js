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

  // ── lo que sí ──────────���─────────────────────────────────────

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
    );
    // extender el plazo y volver a intentar
    await escrow.write.extend([1n, BigInt((await ahora()) + DIA)], { account: verifier.account });
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
  });

  // ── pruebas del nuevo comportamiento ─────────────────────────────────────

  it("el exploit está cerrado: challenge después del plazo extiende y permite settle", async () => {
    // plazo de 1 día, ventana de objeción de 1 día
    await post(1, 7, 1);
    // avanzar hasta justo después del plazo original
    await networkHelpers.time.increase(1 * DIA + 10);
    // el financiador objeta; debería extender el plazo
    await escrow.write.challenge([1n], { account: funder.account });
    const nuevoPlazo = await plazo(1n);
    assert.ok(nuevoPlazo > (await ahora()));
    // refund debe revertir con TooEarly
    await assert.rejects(
      escrow.write.refund([1n], { account: funder.account }),
      /TooEarly/,
    );
    // el verificador puede liquidar dentro del nuevo plazo
    await escrow.write.settle([1n, developer.account.address, EVIDENCE], { account: verifier.account });
  });

  it("cuando queda mucho tiempo, challenge no cambia el plazo", async () => {
    // plazo de 7 días, ventana de 1 día
    await post(7, 14, 1);
    const antes = await plazo(1n);
    // challenge antes de que quede menos de la ventana
    await escrow.write.challenge([1n], { account: funder.account });
    const despues = await plazo(1n);
    assert.equal(antes, despues, "El plazo no debe cambiar");
  });

  it("el financiador puede reembolsar después de que el nuevo plazo expire sin settlement", async () => {
    // plazo de 1 día, ventana de 1 día
    await post(1, 7, 1);
    // avanzar hasta después del plazo original
    await networkHelpers.time.increase(1 * DIA + 10);
    // challenge extiende el plazo
    await escrow.write.challenge([1n], { account: funder.account });
    const nuevoPlazo = await plazo(1n);
    // avanzar hasta después del nuevo plazo
    const avanzar = nuevoPlazo - (await ahora()) + 10;
    await networkHelpers.time.increase(avanzar);
    // ahora el refund debe funcionar
    await escrow.write.refund([1n], { account: funder.account });
    // comprobar que el balance del bounty es 0
    const bounty = await escrow.read.getBounty([1n]);
    assert.equal(bounty.amount, 0n);
  });
});
