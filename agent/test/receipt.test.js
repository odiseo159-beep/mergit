// El recibo y la detección de créditos: solo funciones puras de receipt.mjs.
// Sin red: no se importa on-event.mjs, que corre al cargarse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditedToDeveloper, recibo, RECIBO } from "../receipt.mjs";

const DEV = "0xabc0000000000000000000000000000000000001";
const FEE = "0xFEE0000000000000000000000000000000000002";
const PAYOUT = 1000000000000000000n; // 1 ETH
const COMISION = 20000000000000000n; // 0.02 ETH

const base = {
  bountyId: "25",
  developer: DEV,
  via: `@ana's profile README`,
  author: "ana",
  paid: PAYOUT,
  fee: COMISION,
  headSha: "deadbeefcafebabe",
  evidenceHash: "0xabc123",
  tx: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  url: "https://sepolia-explorer.giwa.io/tx/0x1234567890abcdef",
};

const creditado = (bountyId, to, amount) => ({
  eventName: "PaymentCredited",
  args: { bountyId, to, amount },
});

test("entregado: el recibo no cambia ni un byte", () => {
  const esperado = [
    RECIBO,
    `**Mergit paid this pull request.**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Bounty | #25 |`,
    `| Paid to | \`${DEV}\` — @ana's profile README |`,
    `| Amount | 1 ETH (protocol fee 0.02 ETH) |`,
    `| Verified | merged, CI green on head commit \`deadbee\` |`,
    `| Evidence hash | \`0xabc123\` |`,
    `| Transaction | [0x12345678…cdef](https://sepolia-explorer.giwa.io/tx/0x1234567890abcdef) on GIWA Sepolia |`,
    ``,
    `Your record: https://www.mergit.xyz/p/ana`,
    ``,
    `Put this in your profile README and it will show what your merged work was paid, read straight from the chain:`,
    ``,
    "```markdown",
    `[![Mergit](https://www.mergit.xyz/badge/ana.svg)](https://www.mergit.xyz/p/ana)`,
    "```",
    ``,
    `Merge it. Get paid.`,
  ].join("\n");
  assert.equal(recibo(base), esperado);
});

test("acreditado al desarrollador: dice aprobado, no dice paid", () => {
  const credited = creditedToDeveloper(
    [creditado("25", DEV, PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, PAYOUT);
  const texto = recibo({ ...base, credited });
  assert.ok(texto.startsWith(RECIBO));
  assert.ok(texto.includes("**Mergit approved this payment. It is waiting to be withdrawn.**"));
  assert.ok(texto.includes("Credited to"));
  assert.ok(texto.includes("still in the escrow"));
  assert.ok(texto.includes("withdrawTo(address)"));
  assert.ok(!texto.includes("Paid to"));
  assert.ok(!/paid/i.test(texto));
  assert.ok(!texto.includes("pagado"));
});

test("solo la comisión acreditada: no cuenta como pago al desarrollador", () => {
  const credited = creditedToDeveloper(
    [creditado("25", FEE, COMISION)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});

test("un crédito de otro bounty no cuenta", () => {
  const credited = creditedToDeveloper(
    [creditado("26", DEV, PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});

test("la dirección en distinta mayúscula cuenta igual", () => {
  const credited = creditedToDeveloper(
    [creditado("25", DEV.toUpperCase(), PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, PAYOUT);
});

test("un importe distinto al payout no cuenta", () => {
  const credited = creditedToDeveloper(
    [creditado("25", DEV, PAYOUT + 1n)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});
