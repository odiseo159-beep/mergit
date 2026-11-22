// Pruebas unitarias de agent/bounties.mjs — sin red: fetch está simulado
// donde logsOf lo necesita. Ejecutar con `node --test test/` desde agent/.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;

import {
  ESCROWS,
  logsOf,
  listBounties,
  settlementOf,
  pointsAtRepo,
  isLive,
  closedIssues,
  pointsAtIssue,
  LINEA_BOUNTY,
  bountyForIssue,
} from "../bounties.mjs";

// ───────────────────────── simulador de fetch ───────────────────────────────
let pages; // clave: "<direcciónEscrow>|<cursor>" -> { items, next_page_params } o { fail }
function keyOf(address, cursor) {
  return String(address).toLowerCase() + "|" + String(cursor ?? "");
}
function mockFetch() {
  globalThis.fetch = async (url) => {
    const s = String(url);
    const m = s.match(/addresses\/([0-9a-fA-Fx]+)\/logs/);
    const address = m ? m[1] : "unknown";
    const qs = s.includes("?") ? s.split("?")[1] : "";
    const cur = new URLSearchParams(qs).get("cursor") ?? "";
    const entry = pages[keyOf(address, cur)];
    if (!entry) throw new Error(`mock fetch: no page for ${s}`);
    if (entry.fail) throw new Error(entry.fail);
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: entry.items || [], next_page_params: entry.next_page_params ?? null }),
    };
  };
}

beforeEach(() => {
  pages = {};
  mockFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const EX1 = ESCROWS[0].address;
const EX2 = ESCROWS[1].address;

const posted = (bountyId, uri, extra = {}) => ({
  kind: "BountyPosted",
  transaction_hash: "0xtx" + bountyId,
  bountyId: String(bountyId),
  metadataURI: uri,
  funder: "0xfunder1",
  verifier: "0xverifier1",
  amount: "1000000",
  deadline: "0",
  ...extra,
});

// ───────────────────────── pointsAtRepo ────────────────────────────────────
describe("pointsAtRepo", () => {
  const owner = "odiseo159-beep";
  const repo = "mergit";

  test("el mismo repositorio cuenta", () => {
    assert.equal(pointsAtRepo("https://github.com/odiseo159-beep/mergit/issues/1", owner, repo), true);
    assert.equal(pointsAtRepo("github.com/odiseo159-beep/mergit", owner, repo), true);
    assert.equal(pointsAtRepo("github.com/odiseo159-beep/mergit/", owner, repo), true);
    assert.equal(pointsAtRepo("https://github.com/odiseo159-beep/mergit/tree/main/agent", owner, repo), true);
  });

  test("el esquema y www son opcionales", () => {
    assert.equal(pointsAtRepo("WWW.github.com/odiseo159-beep/mergit", owner, repo), true);
    assert.equal(pointsAtRepo("http://github.com/odiseo159-beep/mergit", owner, repo), true);
  });

  test("un repositorio cuyo nombre solo empieza igual no cuenta (mergit frente a mergit-demo)", () => {
    assert.equal(pointsAtRepo("github.com/odiseo159-beep/mergit-demo/issues/1", owner, repo), false);
  });

  test("otro dominio con la misma ruta no cuenta", () => {
    assert.equal(pointsAtRepo("https://evil.example/github.com/odiseo159-beep/mergit/issues/1", owner, repo), false);
    assert.equal(pointsAtRepo("gitlab.com/odiseo159-beep/mergit/issues/1", owner, repo), false);
  });

  test("el texto libre no cuenta", () => {
    assert.equal(pointsAtRepo("see github for details, it is great", owner, repo), false);
    assert.equal(pointsAtRepo("", owner, repo), false);
  });

  test("los puntos en el propietario son literales", () => {
    assert.equal(pointsAtRepo("github.com/a.b/c", "a.b", "c"), true);
    assert.equal(pointsAtRepo("github.com/axb/c", "a.b", "c"), false);
  });

  test("otro propietario con el mismo nombre de repositorio no cuenta", () => {
    assert.equal(pointsAtRepo("github.com/someoneelse/mergit", owner, repo), false);
  });
});

// ───────────────────────── pointsAtIssue ───────────────────────────────────
describe("pointsAtIssue", () => {
  const owner = "odiseo159-beep";
  const repo = "mergit";

  test("el issue #1 no coincide con el issue #10", () => {
    assert.equal(pointsAtIssue("github.com/odiseo159-beep/mergit/issues/1", owner, repo, 1), true);
    assert.equal(pointsAtIssue("github.com/odiseo159-beep/mergit/issues/10", owner, repo, 1), false);
    assert.equal(pointsAtIssue("github.com/odiseo159-beep/mergit/issues/1", owner, repo, 10), false);
  });

  test("la URL exacta del issue cuenta", () => {
    assert.equal(pointsAtIssue("https://github.com/odiseo159-beep/mergit/issues/17", owner, repo, 17), true);
  });

  test("un punto en el nombre del propietario es literal", () => {
    assert.equal(pointsAtIssue("github.com/a.b/c/issues/1", "a.b", "c", 1), true);
    assert.equal(pointsAtIssue("github.com/axb/c/issues/1", "a.b", "c", 1), false);
  });

  test("el texto libre no cuenta", () => {
    assert.equal(pointsAtIssue("fixes issues when convenient", owner, repo, 1), false);
  });
});

// ───────────────────────── LINEA_BOUNTY ────────────────────────────────────
describe("LINEA_BOUNTY", () => {
  test("coincide con la línea canónica", () => {
    assert.match("Bounty: #12", LINEA_BOUNTY);
    assert.match("bounty: #12", LINEA_BOUNTY);
    assert.match("  BOUNTY:   #12  ", LINEA_BOUNTY);
    assert.match("Bounty: 12", LINEA_BOUNTY);
  });

  test("funciona con finales de línea de Windows (\\r antes de \\n)", () => {
    assert.match("some line\r\nBounty: #34\r\nnext", LINEA_BOUNTY);
  });

  test("no salta a la línea siguiente", () => {
    assert.equal(LINEA_BOUNTY.test("Bounty:\n#34"), false);
    assert.equal(LINEA_BOUNTY.test("Bounty:\r\n#34"), false);
  });

  test("ignora una mención a mitad de una frase", () => {
    assert.equal(LINEA_BOUNTY.test("The Bounty: #34 line was added by the bot"), false);
    assert.equal(LINEA_BOUNTY.test("see Bounty: #34 for details"), false);
  });

  test("captura el número del issue", () => {
    const m = "Bounty: #99".match(LINEA_BOUNTY);
    assert.equal(m[1], "99");
  });
});

// ───────────────────────── closedIssues ────────────────────────────────────
describe("closedIssues", () => {
  test("cada forma de close, fix y resolve", () => {
    assert.deepEqual(
      closedIssues("closes #1, close #2, closed #3"),
      [1, 2, 3],
    );
    assert.deepEqual(closedIssues("fixes #4"), [4]);
    assert.deepEqual(closedIssues("fix #5"), [5]);
    assert.deepEqual(closedIssues("fixed #6"), [6]);
    assert.deepEqual(closedIssues("resolves #7"), [7]);
    assert.deepEqual(closedIssues("resolve #8"), [8]);
    assert.deepEqual(closedIssues("resolved #9"), [9]);
  });

  test("las formas mezcladas y los duplicados se deduplican", () => {
    const body = "closes #1, fixes #1, resolves #2, Closes #2";
    assert.deepEqual(closedIssues(body).sort((a, b) => a - b), [1, 2]);
  });

  test("las palabras clave no distinguen mayúsculas", () => {
    assert.deepEqual(closedIssues("CLOSES #1 FIX #2"), [1, 2]);
  });

  test("los números sin palabra clave se ignoran", () => {
    assert.deepEqual(closedIssues("issue #1 is not closed by the word #2"), []);
    assert.deepEqual(closedIssues(""), []);
    assert.deepEqual(closedIssues(null), []);
  });

  test("la palabra clave seguida de dos puntos también cuenta", () => {
    assert.deepEqual(closedIssues("Closes: #42"), [42]);
    assert.deepEqual(closedIssues("fixes: #43, resolves: #44"), [43, 44]);
  });
});

// ───────────────────────── logsOf ──────────────────────────────────────────
describe("logsOf", () => {
  test("sigue next_page_params entre páginas", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [{ decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "1" }] }, transaction_hash: "0xa" }],
        next_page_params: { cursor: "page2" },
      },
      [keyOf(EX1, "page2")]: {
        items: [{ decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "2" }] }, transaction_hash: "0xb" }],
        next_page_params: null,
      },
    };
    const ev = await logsOf(EX1);
    assert.equal(ev.length, 2);
    assert.deepEqual(ev.map((e) => e.bountyId), ["1", "2"]);
  });

  test("lanza error cuando una página falla", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [],
        next_page_params: { cursor: "page2" },
      },
      [keyOf(EX1, "page2")]: { fail: "explorer 500" },
    };
    await assert.rejects(() => logsOf(EX1), /explorer 500/);
  });

  test("decodifica los parámetros en campos con nombre", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [{
          decoded: {
            method_call: "BountyPosted(uint256,string)",
            parameters: [
              { name: "bountyId", value: "7" },
              { name: "metadataURI", value: "github.com/o/r/issues/1" },
            ],
          },
          transaction_hash: "0xc",
        }],
        next_page_params: null,
      },
    };
    const ev = await logsOf(EX1);
    assert.equal(ev[0].kind, "BountyPosted");
    assert.equal(ev[0].bountyId, "7");
    assert.equal(ev[0].metadataURI, "github.com/o/r/issues/1");
    assert.equal(ev[0].tx, "0xc");
  });

  test("ignora los eventos sin datos decodificados", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [{ decoded: null }, { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "3" }] } }],
        next_page_params: null,
      },
    };
    const ev = await logsOf(EX1);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].bountyId, "3");
  });

  test("pasa la dirección del escrow a la ruta del explorador", async () => {
    let seen = "";
    pages = { [keyOf(EX1, "")]: { items: [], next_page_params: null } };
    globalThis.fetch = async (url) => { seen = String(url); return { ok: true, json: async () => ({ items: [], next_page_params: null }) }; };
    await logsOf(EX1);
    assert.match(seen, new RegExp(EX1.replace(/\./g, "\\.")));
  });
});

// ───────────────────────── bountyForIssue ──────────────────────────────────
describe("bountyForIssue", () => {
  const owner = "odiseo159-beep";
  const repo = "mergit";
  const issue = 17;
  const uri = (n) => `github.com/${owner}/${repo}/issues/${n}`;
  const live = (id, extra = {}) => ({
    id: String(id),
    uri: uri(issue),
    funder: "0xfunder1",
    verifier: "0xverifier1",
    amount: "1000000",
    deadline: Math.floor(Date.now() / 1000) + 86400,
    closed: false,
    ...extra,
  });

  test("con exactamente una coincidencia se devuelve un bounty", () => {
    const r = bountyForIssue({ bounties: [live(1)], owner, repo, issue });
    assert.equal(r.bounty.id, "1");
    assert.equal(r.reason, undefined);
  });

  test("sin coincidencias hay razón y sin bounty", () => {
    const r = bountyForIssue({ bounties: [], owner, repo, issue });
    assert.equal(r.bounty, undefined);
    assert.match(r.reason, /no open bounty points at issue #17/);
  });

  test("dos bounties abiertos dan una ambigüedad y no devuelven nada", () => {
    const r = bountyForIssue({ bounties: [live(1), live(2)], owner, repo, issue });
    assert.equal(r.bounty, undefined);
    assert.match(r.reason, /2 open bounties point at issue #17/);
    assert.ok(r.ambiguous);
    assert.equal(r.ambiguous.length, 2);
  });

  test("los bounties cerrados no son candidatos", () => {
    const r = bountyForIssue({ bounties: [live(1, { closed: true })], owner, repo, issue });
    assert.match(r.reason, /no open bounty/);
  });

  test("los plazos vencidos no son candidatos", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const r = bountyForIssue({ bounties: [live(1, { deadline: past })], owner, repo, issue });
    assert.match(r.reason, /no open bounty/);
  });

  test("un bounty que apunta a otro issue no cuenta", () => {
    const other = live(1, { uri: uri(issue + 1) });
    const r = bountyForIssue({ bounties: [other], owner, repo, issue });
    assert.match(r.reason, /no open bounty/);
  });

  test("el verificador estrecha los candidatos", () => {
    const a = live(1, { verifier: "0xaaa" });
    const b = live(2, { verifier: "0xbbb" });
    const r = bountyForIssue({ bounties: [a, b], owner, repo, issue, verifier: "0xbbb" });
    assert.equal(r.bounty.id, "2");
  });

  test("los financiadores estrechan los candidatos y quitan la ambigüedad", () => {
    const a = live(1, { funder: "0xaaa" });
    const b = live(2, { funder: "0xbbb" });
    const r = bountyForIssue({ bounties: [a, b], owner, repo, issue, funders: ["0xAAA"] });
    assert.equal(r.bounty.id, "1");
  });

  test("un bounty de 1 wei de un financiador desconocido no crea ambigüedad cuando se listan financiadores", () => {
    const real = live(1, { funder: "0xfunder1" });
    const wei = live(2, { funder: "0xstranger", amount: "1" });
    const r = bountyForIssue({ bounties: [real, wei], owner, repo, issue, funders: ["0xfunder1"] });
    assert.equal(r.bounty.id, "1");
  });
});

// ───────────────────────── isLive ──────────────────────────────────────────
describe("isLive", () => {
  test("abierto y sin vencer está vivo", () => {
    const b = { closed: false, deadline: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(isLive(b), true);
  });
  test("cerrado no está vivo", () => {
    const b = { closed: true, deadline: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(isLive(b), false);
  });
  test("el plazo vencido no está vivo", () => {
    const b = { closed: false, deadline: Math.floor(Date.now() / 1000) - 1 };
    assert.equal(isLive(b), false);
  });
});

// ───────────────────────── listBounties ────────────────────────────────────
describe("listBounties", () => {
  test("salta un escrow muerto sin dirección única, pero lanza error con una", async () => {
    pages = {
      [keyOf(EX1, "")]: { fail: "down" },
      [keyOf(EX2, "")]: { items: [{ decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "5" }] } }], next_page_params: null },
    };
    const all = await listBounties();
    assert.equal(all.length, 1);
    await assert.rejects(() => listBounties({ address: EX1 }), /down/);
  });

  test("filtra los bounties de prueba por debajo del número `from` del escrow", async () => {
    pages = {
      [keyOf(EX2, "")]: { items: [], next_page_params: null },
      [keyOf(EX1, "")]: {
        items: [
          { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "1" }] } },
          { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "9" }] } },
        ],
        next_page_params: null,
      },
    };
    const all = await listBounties();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "9");
  });

  test("marca como cerrados los bounties liquidados o devueltos", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [
          { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "3" }] } },
          { decoded: { method_call: "BountySettled(uint256)", parameters: [{ name: "bountyId", value: "3" }] } },
          { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "4" }] } },
          { decoded: { method_call: "BountyRefunded(uint256)", parameters: [{ name: "bountyId", value: "4" }] } },
        ],
        next_page_params: null,
      },
    };
    const all = await listBounties();
    assert.equal(all.filter((b) => b.closed).length, 2);
  });

  test("settlementOf devuelve los detalles del pago", async () => {
    pages = {
      [keyOf(EX1, "")]: {
        items: [
          { decoded: { method_call: "BountyPosted(uint256)", parameters: [{ name: "bountyId", value: "9" }] } },
          { decoded: { method_call: "BountySettled(uint256,uint256,uint256,bytes32)", parameters: [
            { name: "bountyId", value: "9" },
            { name: "developer", value: "0xdev" },
            { name: "paidToDeveloper", value: "950000" },
            { name: "protocolFee", value: "50000" },
            { name: "evidenceHash", value: "0xhash" },
          ] }, transaction_hash: "0xsettle" },
        ],
        next_page_params: null,
      },
    };
    const s = await settlementOf(EX1, "9");
    assert.equal(s.developer, "0xdev");
    assert.equal(s.tx, "0xsettle");
    assert.equal(await settlementOf(EX1, "999"), null);
  });
});
