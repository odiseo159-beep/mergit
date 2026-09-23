import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { keccak256, toHex } from "viem";

const LOGIN = "odiseo159-beep";
const PROOF = "https://gist.github.com/odiseo159-beep/abc123";

describe("MergitRegistry", async () => {
  const { viem } = await network.connect();

  let registry, dev, other, publicClient;

  beforeEach(async () => {
    [dev, other] = await viem.getWalletClients();
    publicClient = await viem.getPublicClient();
    registry = await viem.deployContract("MergitRegistry", []);
  });

  const hash = (login) => keccak256(toHex(login.toLowerCase()));

  // ── reclamar ──────────────────────────────────────────────────

  it("guarda la wallet que reclama un login", async () => {
    await registry.write.claim([LOGIN, PROOF]);

    assert.equal(
      (await registry.read.walletOf([LOGIN])).toLowerCase(),
      dev.account.address.toLowerCase(),
    );
    assert.equal(await registry.read.totalClaims(), 1n);
  });

  it("indexa el login sin distinguir mayúsculas, como GitHub", async () => {
    await registry.write.claim([LOGIN, PROOF]);

    const upper = LOGIN.toUpperCase();
    assert.equal(
      (await registry.read.walletOf([upper])).toLowerCase(),
      dev.account.address.toLowerCase(),
    );
    assert.equal(await registry.read.hashLogin([upper]), hash(LOGIN));
  });

  it("deja el índice inverso listo para un perfil", async () => {
    await registry.write.claim([LOGIN, PROOF]);
    assert.equal(await registry.read.loginOf([dev.account.address]), hash(LOGIN));
  });

  it("guarda la prueba y la fecha junto a la reclamación", async () => {
    await registry.write.claim([LOGIN, PROOF]);
    const claim = await registry.read.claimOf([LOGIN]);

    assert.equal(claim.login, LOGIN);
    assert.equal(claim.proofURI, PROOF);
    assert.ok(claim.claimedAt > 0n);
  });

  it("emite Claimed con el login en claro, para poder indexarlo fuera", async () => {
    const tx = await registry.write.claim([LOGIN, PROOF]);
    await publicClient.waitForTransactionReceipt({ hash: tx });

    const [event] = await registry.getEvents.Claimed();
    assert.equal(event.args.login, LOGIN);
    assert.equal(event.args.loginHash, hash(LOGIN));
  });

  // ── lo que no se permite ──────────────────────────────────────

  it("no deja que otra wallet se quede con un login ya reclamado", async () => {
    await registry.write.claim([LOGIN, PROOF]);

    await assert.rejects(
      registry.write.claim([LOGIN, PROOF], { account: other.account }),
      /LoginTaken/,
    );
  });

  it("no deja que una wallet acumule dos logins", async () => {
    await registry.write.claim([LOGIN, PROOF]);

    await assert.rejects(registry.write.claim(["otro-login", PROOF]), /WalletBusy/);
  });

  it("rechaza un login vacío o una prueba vacía", async () => {
    await assert.rejects(registry.write.claim(["", PROOF]), /EmptyLogin/);
    await assert.rejects(registry.write.claim([LOGIN, ""]), /EmptyProof/);
  });

  // ── actualizar y soltar ───────────────────────────────────────

  it("deja al dueño cambiar su prueba sin perder la antigüedad", async () => {
    await registry.write.claim([LOGIN, PROOF]);
    const before = await registry.read.claimOf([LOGIN]);

    const nueva = "https://github.com/odiseo159-beep/odiseo159-beep";
    await registry.write.claim([LOGIN, nueva]);
    const after = await registry.read.claimOf([LOGIN]);

    assert.equal(after.proofURI, nueva);
    assert.equal(after.claimedAt, before.claimedAt);
    assert.equal(await registry.read.totalClaims(), 1n);
  });

  it("permite soltar el login, y entonces otra wallet puede tomarlo", async () => {
    await registry.write.claim([LOGIN, PROOF]);
    await registry.write.release();

    assert.equal(
      await registry.read.walletOf([LOGIN]),
      "0x0000000000000000000000000000000000000000",
    );
    assert.equal(await registry.read.totalClaims(), 0n);

    await registry.write.claim([LOGIN, PROOF], { account: other.account });
    assert.equal(
      (await registry.read.walletOf([LOGIN])).toLowerCase(),
      other.account.address.toLowerCase(),
    );
  });

  it("no deja soltar lo que no se tiene", async () => {
    await assert.rejects(registry.write.release(), /NothingToRelease/);
  });

  // ── lecturas de un login libre ────────────────────────────────

  it("un login sin reclamar devuelve la dirección cero", async () => {
    assert.equal(
      await registry.read.walletOf(["nadie"]),
      "0x0000000000000000000000000000000000000000",
    );
  });
});
