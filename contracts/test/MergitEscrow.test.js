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

  // ── guardia de reentrada (Issue #2, Bounty: #10) ───────────────
  //
  // Comprobamos que `nonReentrant` protege activamente las funciones
  // `settle` y `refund` ante callbacks reentrantes tanto sobre el mismo
  // bounty como sobre otros concurrentes, validando los saldos finales
  // y el selector exacto de error Reentrancy().

  const SELECTOR_REENTRANCY = "0xab143c06"; // bytes4(keccak256("Reentrancy()"))

  async function desplegarAtacante() {
    return viem.deployContract("AtacanteDeReentrada", [escrow.address]);
  }

  it("settle: la reentrada sobre el mismo bounty es bloqueada por nonReentrant", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();
    const monto = parseEther("1");

    await escrow.write.postBounty([atacante.address, deadline, "bounty-1"], {
      value: monto,
      account: funder.account,
    });
    // Modo 1 = SettleMismoBounty
    await atacante.write.configurarAtaque([1, 1n, 1n]);

    await atacante.write.iniciarSettle([1n, keccak256(toHex("prueba-settle-mismo"))]);

    assert.equal(await atacante.read.llamadaRecibida(), true, "el callback receive() se ejecuto");
    assert.equal(await atacante.read.ataqueBloqueado(), true, "la guardia detuvo la reentrada");
    assert.equal(await atacante.read.ultimoErrorSelector(), SELECTOR_REENTRANCY);

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 2, "el bounty quedo Settled");
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n, "balance del escrow en cero");
  });

  it("settle: liquidar otro bounty dentro del payout es bloqueado por la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();

    await escrow.write.postBounty([atacante.address, deadline, "bounty-1"], {
      value: parseEther("1"),
      account: funder.account,
    });
    await escrow.write.postBounty([atacante.address, deadline, "bounty-2"], {
      value: parseEther("2"),
      account: funder.account,
    });
    // Modo 2 = SettleOtroBounty
    await atacante.write.configurarAtaque([2, 1n, 2n]);

    await atacante.write.iniciarSettle([1n, keccak256(toHex("prueba-settle-otro"))]);

    assert.equal(await atacante.read.ataqueBloqueado(), true, "la guardia impidio el segundo settle");
    assert.equal(await atacante.read.ultimoErrorSelector(), SELECTOR_REENTRANCY);

    const b2 = await escrow.read.getBounty([2n]);
    assert.equal(b2.status, 1, "el segundo bounty continua Open");
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      parseEther("2"),
      "los fondos del segundo bounty permanecen intactos",
    );
  });

  it("refund: reembolsar el mismo bounty desde receive() es bloqueado por la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline(60);

    // El atacante crea su propio bounty como funder
    await atacante.write.publicarBounty([deadline], { value: parseEther("1") });
    // Modo 3 = RefundMismoBounty
    await atacante.write.configurarAtaque([3, 1n, 1n]);

    await networkHelpers.time.increaseTo(Number(deadline) + 1);
    await atacante.write.iniciarRefund([1n]);

    assert.equal(await atacante.read.llamadaRecibida(), true, "receive() fue invocado");
    assert.equal(await atacante.read.ataqueBloqueado(), true, "la reentrada fue rechazada");
    assert.equal(await atacante.read.ultimoErrorSelector(), SELECTOR_REENTRANCY);

    const b = await escrow.read.getBounty([1n]);
    assert.equal(b.status, 3, "el bounty paso a Refunded");
    assert.equal(await publicClient.getBalance({ address: escrow.address }), 0n);
  });

  it("refund: forzar settle de otro bounty durante refund es bloqueado por la guardia", async () => {
    const atacante = await desplegarAtacante();
    const deadlineCorto = await futureDeadline(60);
    const deadlineLargo = await futureDeadline(3600);

    await atacante.write.publicarBounty([deadlineCorto], { value: parseEther("1") });
    await escrow.write.postBounty([atacante.address, deadlineLargo, "bounty-largo"], {
      value: parseEther("2"),
      account: funder.account,
    });
    // Modo 4 = SettleDuranteRefund
    await atacante.write.configurarAtaque([4, 1n, 2n]);

    await networkHelpers.time.increaseTo(Number(deadlineCorto) + 1);
    await atacante.write.iniciarRefund([1n]);

    assert.equal(await atacante.read.ataqueBloqueado(), true);
    assert.equal(await atacante.read.ultimoErrorSelector(), SELECTOR_REENTRANCY);

    const b2 = await escrow.read.getBounty([2n]);
    assert.equal(b2.status, 1, "el bounty largo sigue Open");
    assert.equal(
      await publicClient.getBalance({ address: escrow.address }),
      parseEther("2"),
      "el balance del escrow preserva los fondos del bounty 2",
    );
  });

  it("verificacion de saldos: la guardia asegura que ningun atacante drene fondos adicionales", async () => {
    const atacante = await desplegarAtacante();
    const deadline = await futureDeadline();
    const valorBounty = parseEther("1");

    await escrow.write.postBounty([atacante.address, deadline, "bounty-saldo"], {
      value: valorBounty,
      account: funder.account,
    });
    await atacante.write.configurarAtaque([1, 1n, 1n]);

    const balanceEscrowAntes = await publicClient.getBalance({ address: escrow.address });
    const balanceAtacanteAntes = await publicClient.getBalance({ address: atacante.address });

    await atacante.write.iniciarSettle([1n, keccak256(toHex("saldo-check"))]);

    const balanceEscrowDespues = await publicClient.getBalance({ address: escrow.address });
    const balanceAtacanteDespues = await publicClient.getBalance({ address: atacante.address });

    const comisionEsperada = (valorBounty * FEE_BPS) / BPS;
    const pagoEsperado = valorBounty - comisionEsperada;

    assert.equal(balanceAtacanteDespues - balanceAtacanteAntes, pagoEsperado);
    assert.equal(balanceEscrowAntes - balanceEscrowDespues, valorBounty);
  });
});
