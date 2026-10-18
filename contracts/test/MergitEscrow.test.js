import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, keccak256, toHex } from "viem";

const FEE_BPS = 150n; // 1.5% — la comisión que anuncia el pitch
const BPS = 10_000n;

describe("MergitEscrow", async () => {
  const { viem, networkHelpers } = await network.connect();

  let escrow, funder, verifier, developer, stranger, feeRecipient, publicClient;

  async function futureDeadline(secondsAhead = 3600) {
    const block = await publicClient.getBlock();
    return BigInt(block.timestamp) + BigInt(secondsAhead);
  }

  beforeEach(async () => {
    [funder, verifier, developer, stranger, feeRecipient] =
      await viem.getWalletClients();
    publicClient = await viem.getPublicClient();
    escrow = await viem.deployContract("MergitEscrow", [
      Number(FEE_BPS),
      feeRecipient.account.address,
    ]);
  });

  // ── despliegue ────────────────────────────────────────────────

  it("guarda comisión y destinatario como inmutables", async () => {
    assert.equal(await escrow.read.feeBps(), Number(FEE_BPS));
    assert.equal(
      (await escrow.read.feeRecipient()).toLowerCase(),
      feeRecipient.account.address.toLowerCase(),
    );
  });

  it("rechaza una comisión por encima del techo del 5%", async () => {
    await assert.rejects(
      viem.deployContract("MergitEscrow", [501, feeRecipient.account.address]),
      /FeeTooHigh/,
    );
  });

  // ── postBounty ────────────────────────────────────────────────

  it("bloquea el ETH enviado y registra el bounty", async () => {
    const deadline = await futureDeadline();
    await escrow.write.postBounty(
      [verifier.account.address, deadline, "github.com/odiseo/giwa-oracle#7"],
      { value: parseEther("1") },
    );

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.funder.toLowerCase(), funder.account.address.toLowerCase());
    assert.equal(b.verifier.toLowerCase(), verifier.account.address.toLowerCase());
    assert.equal(b.amount, parseEther("1"));
    assert.equal(b.status, 1); // Open

    const balance = await publicClient.getBalance({ address: escrow.address });
    assert.equal(balance, parseEther("1"), "el ETH queda custodiado por el contrato");
  });

  it("rechaza bounties sin fondos o con plazo pasado", async () => {
    const deadline = await futureDeadline();
    await assert.rejects(
      escrow.write.postBounty([verifier.account.address, deadline, ""], { value: 0n }),
      /NoFunds/,
    );
    await assert.rejects(
      escrow.write.postBounty([verifier.account.address, 1n, ""], {
        value: parseEther("1"),
      }),
      /DeadlineInPast/,
    );
  });

  // ── settle ────────────────────────────────────────────────────

  it("el verificador libera el pago al desarrollador, menos la comisión", async () => {
    const deadline = await futureDeadline();
    const amount = parseEther("1");
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: amount,
    });

    const devBefore = await publicClient.getBalance({ address: developer.account.address });
    const feeBefore = await publicClient.getBalance({ address: feeRecipient.account.address });

    const evidence = keccak256(toHex("pr:7|commit:9f2c1ab|ci:pass"));
    await escrow.write.settle([1n, developer.account.address, evidence], {
      account: verifier.account,
    });

    const expectedFee = (amount * FEE_BPS) / BPS;
    const expectedPayout = amount - expectedFee;

    const devAfter = await publicClient.getBalance({ address: developer.account.address });
    const feeAfter = await publicClient.getBalance({ address: feeRecipient.account.address });

    assert.equal(devAfter - devBefore, expectedPayout, "el dev cobra el neto");
    assert.equal(feeAfter - feeBefore, expectedFee, "el protocolo cobra su comisión");
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      0n,
      "no queda polvo en el contrato",
    );

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 2); // Settled
  });

  it("registra la evidencia en el evento para poder auditar el pago", async () => {
    const deadline = await futureDeadline();
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: parseEther("1"),
    });
    const evidence = keccak256(toHex("pr:7|commit:9f2c1ab|ci:pass"));
    await escrow.write.settle([1n, developer.account.address, evidence], {
      account: verifier.account,
    });

    const logs = await escrow.getEvents.BountySettled();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.evidenceHash, evidence);
    assert.equal(
      logs[0].args.developer.toLowerCase(),
      developer.account.address.toLowerCase(),
    );
  });

  it("nadie que no sea el verificador puede liberar los fondos", async () => {
    const deadline = await futureDeadline();
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: parseEther("1"),
    });

    // ni un extraño, ni el propio financiador
    await assert.rejects(
      escrow.write.settle([1n, stranger.account.address, "0x".padEnd(66, "0")], {
        account: stranger.account,
      }),
      /NotVerifier/,
    );
    await assert.rejects(
      escrow.write.settle([1n, funder.account.address, "0x".padEnd(66, "0")], {
        account: funder.account,
      }),
      /NotVerifier/,
    );
  });

  it("no se puede liquidar dos veces el mismo bounty", async () => {
    const deadline = await futureDeadline();
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: parseEther("1"),
    });
    const ev = "0x".padEnd(66, "0");
    await escrow.write.settle([1n, developer.account.address, ev], {
      account: verifier.account,
    });
    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, ev], {
        account: verifier.account,
      }),
      /NotOpen/,
    );
  });

  it("no se puede liquidar después del plazo", async () => {
    const deadline = await futureDeadline(3600);
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: parseEther("1"),
    });

    await networkHelpers.time.increaseTo(Number(deadline) + 1);

    await assert.rejects(
      escrow.write.settle([1n, developer.account.address, "0x".padEnd(66, "0")], {
        account: verifier.account,
      }),
      /DeadlinePassed/,
    );
  });

  // ── refund ────────────────────────────────────────────────────

  it("el financiador recupera los fondos una vez vencido el plazo", async () => {
    const deadline = await futureDeadline(3600);
    const amount = parseEther("2");
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: amount,
    });

    await assert.rejects(escrow.write.refund([1n]), /DeadlineNotReached/);

    await networkHelpers.time.increaseTo(Number(deadline) + 1);
    await escrow.write.refund([1n]);

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 3); // Refunded
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      0n,
      "el contrato devuelve todo",
    );
  });

  it("solo el financiador puede pedir el reembolso", async () => {
    const deadline = await futureDeadline(3600);
    await escrow.write.postBounty([verifier.account.address, deadline, "spec"], {
      value: parseEther("1"),
    });
    await networkHelpers.time.increaseTo(Number(deadline) + 1);

    await assert.rejects(
      escrow.write.refund([1n], { account: stranger.account }),
      /NotFunder/,
    );
    await assert.rejects(
      escrow.write.refund([1n], { account: verifier.account }),
      /NotFunder/,
    );
  });

  // ── varios ────────────────────────────────────────────────────

  it("aísla bounties concurrentes: liquidar uno no afecta al otro", async () => {
    const deadline = await futureDeadline();
    await escrow.write.postBounty([verifier.account.address, deadline, "a"], {
      value: parseEther("1"),
    });
    await escrow.write.postBounty([verifier.account.address, deadline, "b"], {
      value: parseEther("3"),
    });

    await escrow.write.settle([1n, developer.account.address, "0x".padEnd(66, "0")], {
      account: verifier.account,
    });

    assert.equal((await escrow.read.getBounty([1n])).status, 2); // Settled
    assert.equal((await escrow.read.getBounty([2n])).status, 1); // sigue Open
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      parseEther("3"),
      "solo quedan los fondos del bounty vivo",
    );
  });

  it("revierte al consultar un bounty inexistente", async () => {
    await assert.rejects(escrow.read.getBounty([999n]), /UnknownBounty/);
  });

  it("quote desglosa pago y comisión", async () => {
    const [payout, fee] = await escrow.read.quote([parseEther("1")]);
    assert.equal(fee, (parseEther("1") * FEE_BPS) / BPS);
    assert.equal(payout, parseEther("1") - fee);
  });

  // ── reentrada (bounty #2) ─────────────────────────────────────
  //
  // El atacante es verificador y desarrollador a la vez: sus callbacks
  // cumplen todos los roles, así que lo único que puede frenarlos es la
  // guardia de reentrada. Cada test comprueba además QUÉ revirtió, para
  // distinguir "la guardia aguantó" de "un check de estado salvó el día
  // por casualidad".

  const SELECTOR_REENTRANCY = "0xab143c06"; // keccak256("Reentrancy()")[:4]

  async function desplegarAtacante() {
    return viem.deployContract("AtacanteDeReentrada", [escrow.address]);
  }

  it("settle: la reentrada sobre el MISMO bounty choca con la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();
    const amount = parseEther("1");

    // bounty posteado con verifier = atacante; luego settle paga al atacante.
    await escrow.write.postBounty([atacante.address, deadline, "spec"], {
      value: amount,
      account: funder.account,
    });
    await atacante.write.preparar([1n, 1n, 1n]); // ReintentarMismoSettle

    await atacante.write.ejecutarSettle([1n, keccak256(toHex("prueba"))]);

    assert.equal(await atacante.read.reentradaIntentada(), true, "el callback ocurrió");
    assert.equal(await atacante.read.reentradaBloqueada(), true, "la guardia frenó");
    assert.equal(await atacante.read.ultimoSelector(), SELECTOR_REENTRANCY);

    // el bounty quedó Settled una sola vez y el contrato quedó en cero
    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 2); // Settled
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("settle: liquidar OTRO bounty dentro del payout choca con la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();

    // bounty 1: se liquida primero; bounty 2: el que el atacante intenta
    // colarse desde receive(). Sin guardia, ambos pagarían en una sola
    // transacción del verificador: doble pago en un mismo settle.
    await escrow.write.postBounty([atacante.address, deadline, "uno"], {
      value: parseEther("1"),
      account: funder.account,
    });
    await escrow.write.postBounty([atacante.address, deadline, "dos"], {
      value: parseEther("2"),
      account: funder.account,
    });
    await atacante.write.preparar([2n, 1n, 2n]); // ReintentarOtroSettle

    await atacante.write.ejecutarSettle([1n, keccak256(toHex("prueba"))]);

    assert.equal(await atacante.read.reentradaBloqueada(), true);
    assert.equal(await atacante.read.ultimoSelector(), SELECTOR_REENTRANCY);

    // bounty 2 intacto: sigue Open con sus 2 ETH dentro
    const b2 = await escrow.read.getBounty([2n]);
    assert.equal(b2.status, 1); // Open
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      parseEther("2"),
      "el bounty 2 conserva el dinero que el atacante quiso drenar",
    );
  });

  it("refund: reembolsar el MISMO bounty desde receive choca con la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline(60);

    // el atacante financía su propio bounty: el refund le transfiere a él.
    await atacante.write.ejecutarPost([deadline], { value: parseEther("1") });
    await atacante.write.preparar([3n, 1n, 1n]); // ReintentarRefund

    await networkHelpers.time.increaseTo(Number(deadline) + 1);
    await atacante.write.ejecutarRefund([1n]);

    assert.equal(await atacante.read.reentradaIntentada(), true);
    assert.equal(await atacante.read.reentradaBloqueada(), true);
    // el selector distingue la guardia (Reentrancy) de NotOpen: prueba que
    // frenó la guardia, no el cambio de estado previo al envío
    assert.equal(await atacante.read.ultimoSelector(), SELECTOR_REENTRANCY);

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 3); // Refunded
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("refund: colar un settle de OTRO bounty durante el reembolso choca con la guardia", async () => {
    const atacante = await desplegarAtacante();
    const largo = await futureDeadline(3600);
    const corto = await futureDeadline(60);

    // bounty 1: del atacante, con plazo corto → refund lo dispara.
    // bounty 2: verifier = atacante, plazo largo → el settle que quiere colar.
    await atacante.write.ejecutarPost([corto], { value: parseEther("1") });
    await escrow.write.postBounty([atacante.address, largo, "dos"], {
      value: parseEther("2"),
      account: funder.account,
    });
    await atacante.write.preparar([4n, 1n, 2n]); // SettleDuranteRefund

    await networkHelpers.time.increaseTo(Number(corto) + 1);
    await atacante.write.ejecutarRefund([1n]);

    assert.equal(await atacante.read.reentradaBloqueada(), true);
    assert.equal(await atacante.read.ultimoSelector(), SELECTOR_REENTRANCY);

    const b2 = await escrow.read.getBounty([2n]);
    assert.equal(b2.status, 1); // Open — el settle colado no ocurrió
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      parseEther("2"),
      "cada ETH termina donde debe: bounty 1 devuelto, bounty 2 custodiado",
    );
  });

  it("un multiplicador de reentrada no puede extraer más de lo depositado", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();

    await escrow.write.postBounty([atacante.address, deadline, "spec"], {
      value: parseEther("1"),
      account: funder.account,
    });
    await atacante.write.preparar([1n, 1n, 1n]);

    const escrowAntes = await publicClient.getBalance({ address: escrow.address });
    const devAntes = await publicClient.getBalance({ address: atacante.address });

    await atacante.write.ejecutarSettle([1n, keccak256(toHex("prueba"))]);

    const devDespues = await publicClient.getBalance({ address: atacante.address });
    const escrowDespues = await publicClient.getBalance({ address: escrow.address });

    const esperado = parseEther("1") - (parseEther("1") * FEE_BPS) / BPS;
    assert.equal(devDespues - devAntes, esperado, "paga el neto, ni un wei más");
    assert.equal(escrowAntes - escrowDespues, parseEther("1"), "sale exactamente el bounty");
  });
});
