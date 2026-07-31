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
});
