// Lo que no depende de la red: montos, enlaces y el filtro de bounties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eth, wei, parseIssue, fundLink, listOpenBounties, AGENT } from "../tools.mjs";

test("eth y wei van y vuelven sin perder decimales", () => {
  assert.equal(eth(492500000000000n), "0.0004925");
  assert.equal(eth(0n), "0");
  assert.equal(wei("0.0005"), 500000000000000n);
  assert.equal(eth(wei("1.5")), "1.5");
  assert.throws(() => wei("1e-3"));
  assert.throws(() => wei("-1"));
});

test("parseIssue solo acepta issues de GitHub", () => {
  assert.deepEqual(parseIssue("https://github.com/a/b/issues/7"), { owner: "a", repo: "b", number: 7 });
  assert.deepEqual(parseIssue("github.com/a/b.c/issues/7#x"), { owner: "a", repo: "b.c", number: 7 });
  assert.equal(parseIssue("https://github.com/a/b"), null);
  assert.equal(parseIssue("https://github.com/a/b/pull/7"), null);
  assert.equal(parseIssue("https://evil.com/github.com/a/b/issues/7"), null);
});

test("fundLink arma el enlace de /post y no firma nada", async () => {
  const anterior = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await fundLink({ issue_url: "https://github.com/a/b/issues/3", amount_eth: "0.0010" });
  globalThis.fetch = anterior;
  assert.equal(r.link, "https://www.mergit.xyz/post?uri=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F3&amount=0.001");
  assert.deepEqual(r.already_funded, []);
  await assert.rejects(() => fundLink({ issue_url: "https://github.com/a/b", amount_eth: "1" }));
  await assert.rejects(() => fundLink({ issue_url: "https://github.com/a/b/issues/3", amount_eth: "0" }));
});

const respuestaDeLogs = (items) => new Response(JSON.stringify({ items }), {
  status: 200, headers: { "content-type": "application/json" },
});
const eventoPublicado = (id, uri, deadline) => ({
  decoded: {
    method_call: "BountyPosted(uint256,address,address,uint256,uint256,string)",
    parameters: [
      { name: "bountyId", value: String(id) }, { name: "funder", value: "0x1" },
      { name: "verifier", value: AGENT }, { name: "amount", value: "500000000000000" },
      { name: "deadline", value: String(deadline) }, { name: "metadataURI", value: uri },
    ],
  }, transaction_hash: "0xtx",
});

test("fundLink avisa si el issue ya tiene un bounty vivo", async () => {
  const anterior = globalThis.fetch;
  const ahora = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url) => url.includes("ffcf")
    ? respuestaDeLogs([eventoPublicado(8, "https://github.com/a/b/issues/3", ahora + 3600)])
    : respuestaDeLogs([]);
  const r = await fundLink({ issue_url: "https://github.com/a/b/issues/3" });
  globalThis.fetch = anterior;
  assert.deepEqual(r.already_funded, [{ bounty: 8, escrow: "v1", reward_eth: "0.0005", deadline: new Date((ahora + 3600) * 1000).toISOString() }]);
  assert.match(r.warning, /one bounty per issue/i);
});

test("fundLink no cuenta un bounty vencido", async () => {
  const anterior = globalThis.fetch;
  globalThis.fetch = async (url) => url.includes("ffcf")
    ? respuestaDeLogs([eventoPublicado(9, "https://github.com/a/b/issues/3", 1)])
    : respuestaDeLogs([]);
  const r = await fundLink({ issue_url: "https://github.com/a/b/issues/3" });
  globalThis.fetch = anterior;
  assert.deepEqual(r.already_funded, []);
  assert.equal(r.warning, undefined);
});

test("fundLink conserva el enlace si no puede leer el explorador", async () => {
  const anterior = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("sin red"); };
  const r = await fundLink({ issue_url: "https://github.com/a/b/issues/3" });
  globalThis.fetch = anterior;
  assert.equal(r.already_funded, null);
  assert.match(r.note, /could not check/i);
  assert.match(r.link, /mergit\.xyz\/post/);
});

test("la lista deja fuera lo que no es un issue, lo vencido y lo pagado, y marca issues compartidos", async () => {
  const now = Date.parse("2026-11-25T00:00:00Z");
  const vivo = Math.floor(now / 1000) + 86400 * 5;
  const b = (id, uri, extra = {}) => ({
    id: String(id), escrow: "v1", address: "0xffcf", funder: "0x1", verifier: AGENT,
    amount: "500000000000000", deadline: vivo, uri, closed: false, ...extra,
  });
  const r = await listOpenBounties({}, { now, bounties: [
    b(1, "https://github.com/x/y/issues/1"),
    b(2, "https://github.com/x/y/issues/1"),
    b(3, "https://github.com/x/y"),
    b(4, "https://github.com/owner/repo/issues/7"),
    b(5, "https://github.com/x/y/issues/2", { closed: true }),
    b(6, "https://github.com/x/y/issues/3", { deadline: 1 }),
    b(7, "https://github.com/x/y/issues/4", { verifier: "0x9" }),
  ] });
  assert.deepEqual(r.open.map((x) => x.bounty).sort(), [1, 2, 7]);
  assert.equal(r.hidden_without_a_github_issue, 2);
  assert.ok(r.open.find((x) => x.bounty === 1).note);
  assert.equal(r.open.find((x) => x.bounty === 7).paid_automatically_on_merge, false);
  assert.equal(r.total_reward_eth, "0.0015");
});
