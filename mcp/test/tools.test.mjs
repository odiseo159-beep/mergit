// Lo que no depende de la red: montos, enlaces y el filtro de bounties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eth, wei, parseIssue, fundLink, listOpenBounties, AGENT } from "../tools.mjs";

// ─────────────────────── El explorador, de mentira ───────────────────────
// Ningún test de este archivo toca la red: `fundLink` pregunta a la cadena, y
// aquí la cadena es un objeto con la misma forma que devuelve el explorador.

const V1 = "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879";

/** Un `BountyPosted` decodificado, como lo entrega el explorador de GIWA. */
function publicado(id, uri, deadline) {
  return {
    decoded: {
      method_call: "BountyPosted(uint256,address,address,uint256,uint64,string)",
      parameters: [
        { name: "bountyId", value: String(id) },
        { name: "funder", value: "0x1111111111111111111111111111111111111111" },
        { name: "verifier", value: AGENT },
        { name: "amount", value: "500000000000000" },
        { name: "deadline", value: String(deadline) },
        { name: "metadataURI", value: uri },
      ],
    },
    transaction_hash: "0xabc",
  };
}

/**
 * Sustituye `fetch` por el explorador. La v1 devuelve `eventos`; la v2, nada.
 * Con `cae: true`, las dos peticiones fallan.
 */
function conExplorador(eventos, { cae = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (cae) throw new Error("el explorador no responde");
    const esV1 = String(url).includes(V1);
    return { ok: true, json: async () => ({ items: esV1 ? eventos : [], next_page_params: null }) };
  };
  return () => { globalThis.fetch = original; };
}

const dentroDeUnaSemana = Math.floor(Date.now() / 1000) + 86_400 * 7;
const laSemanaPasada = Math.floor(Date.now() / 1000) - 86_400 * 7;
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

test("fundLink arma el enlace de /post y no firma nada", async () => {
  const restaurar = conExplorador([]);
  try {
    const r = await fundLink({ issue_url: ISSUE, amount_eth: "0.0010" });
    assert.equal(r.link, "https://www.mergit.xyz/post?uri=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F3&amount=0.001");
    assert.match(r.who_signs, /user/i);
  } finally {
    restaurar();
  }
});

test("fundLink sigue rechazando lo que no es un issue o no es un monto", async () => {
  const restaurar = conExplorador([]);
  try {
    await assert.rejects(() => fundLink({ issue_url: "https://github.com/a/b", amount_eth: "1" }));
    await assert.rejects(() => fundLink({ issue_url: ISSUE, amount_eth: "0" }));
  } finally {
    restaurar();
  }
});

test("la línea Bounty va en el pull request, no en el issue", async () => {
  const restaurar = conExplorador([]);
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.match(r.what_the_page_does, /Bounty: #N/);
    assert.match(r.what_the_page_does, /pull request, not in the issue/);
  } finally {
    restaurar();
  }
});

test("un issue sin bounty vivo: already_funded vacío y ningún aviso", async () => {
  const restaurar = conExplorador([]);
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.deepEqual(r.already_funded, []);
    assert.equal(r.warning, undefined);
    assert.equal(r.note, undefined);
  } finally {
    restaurar();
  }
});

test("un issue con un bounty vivo: already_funded lo dice y avisa que es uno por issue", async () => {
  const restaurar = conExplorador([publicado(5, ISSUE, dentroDeUnaSemana)]);
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.equal(r.already_funded.length, 1);
    assert.deepEqual(r.already_funded[0], {
      bounty: 5,
      escrow: "v1",
      reward_eth: "0.0005",
      deadline: new Date(dentroDeUnaSemana * 1000).toISOString(),
    });
    assert.match(r.warning, /one bounty per issue/i);
    assert.match(r.warning, /#5/);
    assert.equal(r.note, undefined);
  } finally {
    restaurar();
  }
});

test("un bounty vencido no cuenta como vivo", async () => {
  const restaurar = conExplorador([publicado(6, ISSUE, laSemanaPasada)]);
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.deepEqual(r.already_funded, []);
    assert.equal(r.warning, undefined);
  } finally {
    restaurar();
  }
});

test("un bounty de otro issue no cuenta para este", async () => {
  const restaurar = conExplorador([publicado(7, "https://github.com/a/b/issues/9", dentroDeUnaSemana)]);
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.deepEqual(r.already_funded, []);
  } finally {
    restaurar();
  }
});

test("si la cadena no se puede leer, el enlace sale igual y con la nota", async () => {
  const restaurar = conExplorador([], { cae: true });
  try {
    const r = await fundLink({ issue_url: ISSUE });
    assert.equal(r.already_funded, null);
    assert.equal(r.warning, undefined);
    assert.match(r.note, /could not be read/i);
    assert.equal(r.link, "https://www.mergit.xyz/post?uri=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fissues%2F3&amount=0.0005");
  } finally {
    restaurar();
  }
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
