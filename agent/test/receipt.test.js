// El recibo y la detección de lo acreditado: solo las funciones puras de
// receipt.mjs. Sin red: no se importa on-event.mjs, que corre al cargarse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditedToDeveloper, recibo, RECIBO } from "../receipt.mjs";

const DEV = "0xabc0000000000000000000000000000000000001";
const COMISION_A = "0xfee0000000000000000000000000000000000002";
const PAYOUT = 1000000000000000000n; // 1 ETH
const COMISION = 20000000000000000n; // 0,02 ETH

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

// Un PaymentCredited ya decodificado, con la forma que entrega viem al leer
// el recibo de una transacción.
const acreditado = (bountyId, to, amount) => ({
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
  // Sin eventos de crédito, lo detectado es cero y el recibo es el entregado.
  assert.equal(creditedToDeveloper([], { bountyId: "25", developer: DEV, payout: PAYOUT }), 0n);
});

test("acreditado al desarrollador: el recibo dice aprobado, nunca paid", () => {
  const credited = creditedToDeveloper(
    [acreditado(25n, DEV, PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, PAYOUT);
  const texto = recibo({ ...base, credited });
  assert.ok(texto.startsWith(RECIBO));
  assert.ok(texto.includes("**Mergit approved this payment. It is waiting to be withdrawn.**"));
  assert.ok(texto.includes("| Credited to |"));
  assert.ok(!texto.includes("Paid to"));
  assert.ok(texto.includes("still in the escrow"));
  assert.ok(texto.includes("withdrawTo(address)"));
  assert.ok(!/paid/i.test(texto));
  assert.ok(!/pagado/i.test(texto));
});

test("solo la comisión acreditada: no cuenta como crédito del desarrollador", () => {
  // La comisión también puede quedar acreditada si su destinatario rechaza
  // el ETH: va a otra dirección y por el importe de la comisión.
  const credited = creditedToDeveloper(
    [acreditado(25n, COMISION_A, COMISION)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
  // Y el recibo, sin crédito del desarrollador, es el de un pago entregado.
  assert.equal(recibo({ ...base, credited }), recibo(base));
});

test("un crédito de otro bounty no cuenta", () => {
  const credited = creditedToDeveloper(
    [acreditado(26n, DEV, PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});

test("la dirección en distinta mayúscula cuenta igual", () => {
  const credited = creditedToDeveloper(
    [acreditado("25", DEV.toUpperCase(), PAYOUT)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, PAYOUT);
});

test("la comisión acreditada antes no tapa el crédito del desarrollador", () => {
  // En la misma transacción la comisión se acredita primero: hay que seguir
  // buscando hasta el evento del desarrollador por el payout exacto.
  const credited = creditedToDeveloper(
    [acreditado(25n, COMISION_A, COMISION), acreditado(25n, DEV, PAYOUT)],
    { bountyId: 25n, developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, PAYOUT);
});

test("al desarrollador pero por otro importe no cuenta", () => {
  const credited = creditedToDeveloper(
    [acreditado(25n, DEV, COMISION)],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});

test("eventos ajenos o malformados se saltan, nunca lanzan", () => {
  const credited = creditedToDeveloper(
    [
      { eventName: "BountySettled", args: { bountyId: 25n } },
      { eventName: "PaymentCredited", args: { bountyId: 25n, to: DEV } },
      null,
    ],
    { bountyId: "25", developer: DEV, payout: PAYOUT },
  );
  assert.equal(credited, 0n);
});
