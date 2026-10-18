import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEther, keccak256, toHex, toFunctionSelector } from "viem";

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

  // ── reentrada: se ataca la guardia, no se confía en ella ─────
  //
  // El atacante es financiador y verificador de cuatro bounties propios, y cobra
  // en su propia dirección. Así la llamada reentrante cumple todos los checks de
  // rol y de plazo cuando apunta a otro bounty: lo único que puede frenarla es
  // `nonReentrant`. Cuando apunta al mismo bounty también la frenaría el cambio
  // de estado, por eso cada caso exige el selector de `Reentrancy()` y no
  // `NotOpen()` ni otro error.
  //
  //   1 y 2: plazo corto, ya vencido   -> reembolsables por el atacante
  //   3 y 4: plazo largo, todavía vivo -> liquidables por el atacante

  describe("reentrada", () => {
    const LIQUIDAR = 1;
    const REEMBOLSAR = 2;
    const REENTRANCY = toFunctionSelector("Reentrancy()");
    const IMPORTES = [0n, parseEther("1"), parseEther("2"), parseEther("3"), parseEther("4")];
    const TOTAL = IMPORTES.reduce((a, b) => a + b, 0n);
    const comision = (importe) => (importe * FEE_BPS) / BPS;

    let atacante;

    const estado = async (id) => (await escrow.read.getBounty([id])).status; // 1 Open, 2 Settled, 3 Refunded
    const saldo = (address) => publicClient.getBalance({ address });

    beforeEach(async () => {
      atacante = await viem.deployContract("AtacanteReentrada", [escrow.address]);

      const corto = await futureDeadline(600);
      const largo = await futureDeadline(86_400);
      for (const [plazo, importe] of [
        [corto, IMPORTES[1]],
        [corto, IMPORTES[2]],
        [largo, IMPORTES[3]],
        [largo, IMPORTES[4]],
      ]) {
        await atacante.write.publicar([atacante.address, plazo], { value: importe });
      }

      await networkHelpers.time.increaseTo(Number(corto) + 1);
      assert.equal(await saldo(escrow.address), TOTAL);
    });

    // [nombre, operación externa, bounty externo, ataque, bounty reentrante]
    const CASOS = [
      ["settle -> settle, mismo bounty", LIQUIDAR, 3n, LIQUIDAR, 3n],
      ["settle -> settle, otro bounty", LIQUIDAR, 3n, LIQUIDAR, 4n],
      ["settle -> refund, mismo bounty", LIQUIDAR, 3n, REEMBOLSAR, 3n],
      ["settle -> refund, otro bounty", LIQUIDAR, 3n, REEMBOLSAR, 1n],
      ["refund -> refund, mismo bounty", REEMBOLSAR, 1n, REEMBOLSAR, 1n],
      ["refund -> refund, otro bounty", REEMBOLSAR, 1n, REEMBOLSAR, 2n],
      ["refund -> settle, mismo bounty", REEMBOLSAR, 1n, LIQUIDAR, 1n],
      ["refund -> settle, otro bounty", REEMBOLSAR, 1n, LIQUIDAR, 3n],
    ];

    for (const [nombre, externa, id, ataque, objetivo] of CASOS) {
      it(`la guardia frena ${nombre} y cada saldo queda en su sitio`, async () => {
        const feeAntes = await saldo(feeRecipient.account.address);
        const estadoObjetivoAntes = await estado(objetivo);

        await atacante.write.armar([ataque, objetivo, false]);
        if (externa === LIQUIDAR) {
          await atacante.write.liquidar([id, keccak256(toHex("ataque"))]);
        } else {
          await atacante.write.reembolsar([id]);
        }

        // la reentrada se intentó y la frenó la guardia, no otro check
        assert.equal(await atacante.read.intentado(), true);
        assert.equal(await atacante.read.reentradaExitosa(), false);
        assert.equal(await atacante.read.datosRevert(), REENTRANCY);

        // la operación externa se completó una sola vez
        const fee = externa === LIQUIDAR ? comision(IMPORTES[id]) : 0n;
        assert.equal(await estado(id), externa === LIQUIDAR ? 2 : 3);
        assert.equal(await atacante.read.recibido(), IMPORTES[id] - fee, "el atacante cobra solo lo suyo");
        assert.equal((await saldo(feeRecipient.account.address)) - feeAntes, fee);
        assert.equal(await saldo(atacante.address), IMPORTES[id] - fee);

        // el bounty atacado, si es otro, sigue intacto
        if (objetivo !== id) assert.equal(await estado(objetivo), estadoObjetivoAntes);
        assert.equal(await saldo(escrow.address), TOTAL - IMPORTES[id], "el escrow guarda el resto");
      });
    }

    it("fuera de la guardia, las mismas llamadas sí pasan: el ataque cruzado era real", async () => {
      await atacante.write.armar([LIQUIDAR, 4n, false]);
      await atacante.write.liquidar([3n, keccak256(toHex("ataque"))]);
      assert.equal(await atacante.read.datosRevert(), REENTRANCY);

      // la guardia se soltó al terminar: el bounty 4 y el 2 se cobran por la vía normal
      await atacante.write.liquidar([4n, keccak256(toHex("legítimo"))]);
      await atacante.write.reembolsar([2n]);
      await atacante.write.reembolsar([1n]);

      assert.equal(await estado(4n), 2);
      assert.equal(await estado(2n), 3);
      assert.equal(await saldo(escrow.address), 0n, "no queda nada atrapado");
      assert.equal(
        await saldo(atacante.address),
        TOTAL - comision(IMPORTES[3]) - comision(IMPORTES[4]),
        "cada bounty pagó una sola vez",
      );
    });

    it("si el atacante propaga el revert, se cae todo el pago y nada se mueve", async () => {
      await atacante.write.armar([LIQUIDAR, 4n, true]);

      // _send no reenvía el motivo: el escrow lo reporta como PayoutFailed
      await assert.rejects(atacante.write.liquidar([3n, keccak256(toHex("ataque"))]), /PayoutFailed/);

      assert.equal(await estado(3n), 1);
      assert.equal(await estado(4n), 1);
      assert.equal(await saldo(escrow.address), TOTAL);
      assert.equal(await saldo(atacante.address), 0n);
    });
  });
});
