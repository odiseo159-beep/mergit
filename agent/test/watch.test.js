// Las reglas del vigilante central que deciden qué bounty mira y qué pull
// request lo cobra. Sin red: solo las funciones puras de watch.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { issueOf, candidates, closingMerged, AGENT } from "../watch.mjs";

const ahora = Date.parse("2026-11-24T12:00:00Z");
const futuro = Math.floor(ahora / 1000) + 86400;
const bounty = (id, uri, extra = {}) => ({
  id: String(id), uri, verifier: AGENT, funder: "0xf", amount: "500000000000000",
  deadline: futuro, closed: false, ...extra,
});

test("issueOf: solo un issue de GitHub, con o sin esquema", () => {
  assert.deepEqual(issueOf("https://github.com/ana/app/issues/7")?.key, "ana/app#7");
  assert.equal(issueOf("github.com/ana/app/issues/7/")?.number, 7);
  assert.equal(issueOf("https://github.com/ana/app"), null);
  assert.equal(issueOf("https://github.com/ana/app/pull/7"), null);
  assert.equal(issueOf("https://evil.com/github.com/ana/app/issues/7"), null);
  assert.equal(issueOf("texto libre"), null);
});

test("candidates: deja fuera los repos conectados, los vencidos y otro verificador", () => {
  const { ready } = candidates([
    bounty(1, "https://github.com/ana/app/issues/1"),
    bounty(2, "https://github.com/odiseo159-beep/mergit-demo/issues/22"),
    bounty(3, "https://github.com/ana/app/issues/3", { deadline: futuro - 2 * 86400 }),
    bounty(4, "https://github.com/ana/app/issues/4", { verifier: "0xotro" }),
    bounty(5, "https://github.com/ana/app/issues/5", { closed: true }),
  ], { now: ahora });
  assert.deepEqual(ready.map((r) => r.bounty.id), ["1"]);
});

test("candidates: dos bounties vivos sobre el mismo issue no pagan ninguno", () => {
  const { ready, skipped } = candidates([
    bounty(29, "https://github.com/ana/app/issues/22"),
    bounty(30, "https://github.com/ana/app/issues/22"),
  ], { now: ahora });
  assert.equal(ready.length, 0);
  assert.deepEqual(skipped[0].ids, ["29", "30"]);
});

test("candidates: sobre el tope no se paga solo", () => {
  const { ready, skipped } = candidates([bounty(1, "https://github.com/ana/app/issues/1", { amount: parseEther("0.5").toString() })],
    { now: ahora, maxWei: parseEther("0.01") });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].why, /cap/);
});

test("candidates: un bounty sin issue se descarta con motivo", () => {
  const { ready, skipped } = candidates([bounty(1, "https://github.com/ana/app")], { now: ahora });
  assert.equal(ready.length, 0);
  assert.match(skipped[0].why, /issue/);
});

test("closingMerged: solo mergeados, en el mismo repo, que dicen cerrar ese issue", () => {
  const issue = issueOf("https://github.com/ana/app/issues/1");
  const pr = (n, extra) => ({ number: n, merged_at: "2026-11-24T00:00:00Z", base: { repo: { full_name: "ana/app" } }, body: "Closes #1", ...extra });
  const prs = [
    pr(10),
    pr(11, { merged_at: null }),
    pr(12, { body: "Closes #10" }),
    pr(13, { base: { repo: { full_name: "otro/app" } } }),
    pr(14, { body: "Mentions #1 but closes nothing" }),
  ];
  assert.deepEqual(closingMerged(prs, issue).map((p) => p.number), [10]);
});
