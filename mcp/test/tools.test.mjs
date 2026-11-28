// Lo que no depende de la red: montos, enlaces y el filtro de bounties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eth, wei, parseIssue, fundLink, listOpenBounties, AGENT, ESCROWS } from "../tools.mjs";

// El explorador, fingido por escrow: `listBounties` pide los logs de cada
// escrow por separado, así que cada uno devuelve sus propios eventos y el
// resto, nada. Sin red en ningún test de este archivo.
function simulaExplorador(porEscrow, { falla = false } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (falla) throw new Error("explorer down");
    const clave = Object.keys(porEscrow).find((a) => String(url).toLowerCase().includes(a.toLowerCase()));
    return { ok: true, json: async () => ({ items: clave ? porEscrow[clave] : [], next_page_params: null }) };
  };
  return () => { globalThis.fetch = real; };
}

/** Un `BountyPosted` tal como lo devuelve el explorador, ya decodificado. */
const evento = (id, uri, extra = {}) => ({
  transaction_hash: "0xabc",
  decoded: {
    method_call: "BountyPosted(uint256,address,address,uint256,uint256,string)",
    parameters: [
      { name: "bountyId", value: String(id) },
      { name: "funder", value: "0x1111111111111111111111111111111111111111" },
      { name: "verifier", value: AGENT },
      { name: "amount", value: "500000000000000" },
      { name: "deadline", value: 1893456000 },
      { name: "metadataURI", value: uri },
      ...Object.entries(extra).map(([name, value]) => ({ name, value })),
    ],
  },
});

const ISSUE = "https://github.com/a/b/issues/3";

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

test("fundLink arma el enlace de /post y no firma nada", async (t) => {
  const restaura = simulaExplorador({});
  t.after(restaura);
  const r = await fundLink({ issue_url: ISSUE, amount_eth: "0.0010" });
  assert.equal(r.link, "https://www.mergit.xyz/post?uri=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F3&amount=0.001");
  assert.deepEqual(r.already_funded, []);
  assert.equal(r.warning, undefined);
  assert.match(r.what_the_page_does, /pull request/);
  assert.match(r.what_the_page_does, /Bounty: #N/);
  assert.doesNotMatch(r.what_the_page_does, /paste in the issue/);
  await assert.rejects(() => fundLink({ issue_url: "https://github.com/a/b", amount_eth: "1" }));
  await assert.rejects(() => fundLink({ issue_url: ISSUE, amount_eth: "0" }));
});

test("fundLink avisa cuando el issue ya tiene un bounty vivo, y no otro issue", async (t) => {
  const restaura = simulaExplorador({
    [ESCROWS.v1.address]: [
      evento(7, ISSUE),
      evento(8, "https://github.com/a/b/issues/9"),
    ],
  });
  t.after(restaura);
  const r = await fundLink({ issue_url: ISSUE });
  assert.deepEqual(r.already_funded, [
    { bounty: 7, escrow: "v1", reward_eth: "0.0005", deadline: "2030-01-01T00:00:00.000Z" },
  ]);
  assert.match(r.warning, /Bounty: #7/);
  assert.match(r.warning, /One bounty per issue/);
  assert.ok(r.link);
});

test("fundLink no cuenta un bounty vencido", async (t) => {
  const restaura = simulaExplorador({
    [ESCROWS.v1.address]: [evento(7, ISSUE, { deadline: 1000000000 })],
  });
  t.after(restaura);
  const r = await fundLink({ issue_url: ISSUE });
  assert.deepEqual(r.already_funded, []);
  assert.equal(r.warning, undefined);
  assert.ok(r.link);
});

test("fundLink da el enlace igual si el explorador falla, y lo dice", async (t) => {
  const restaura = simulaExplorador({}, { falla: true });
  t.after(restaura);
  const r = await fundLink({ issue_url: ISSUE });
  assert.equal(r.already_funded, null);
  assert.match(r.note, /Could not read the chain/);
  assert.ok(r.link);
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
