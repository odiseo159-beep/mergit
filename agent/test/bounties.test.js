import test from "node:test";
import assert from "node:assert/strict";

import {
  LINEA_BOUNTY,
  bountyForIssue,
  closedIssues,
  logsOf,
  pointsAtIssue,
  pointsAtRepo,
} from "../bounties.mjs";

// Respuesta mínima con la forma que usa `logsOf`.
function respuestaJson(datos, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return datos;
    },
  };
}

// Un evento decodificado como los entrega el explorador.
function evento({ metodo, parametros, tx = "0x0" }) {
  return {
    decoded: {
      method_call: metodo,
      parameters: Object.entries(parametros).map(([name, value]) => ({ name, value })),
    },
    transaction_hash: tx,
  };
}

test("pointsAtRepo acepta el mismo repositorio y rechaza parecidos, otros dominios y texto libre", () => {
  assert.equal(pointsAtRepo("https://github.com/acme/widgets", "acme", "widgets"), true);
  assert.equal(pointsAtRepo("https://github.com/acme/widgets/issues/7", "acme", "widgets"), true);
  assert.equal(pointsAtRepo("http://www.github.com/acme/widgets/pull/1", "acme", "widgets"), true);

  // El nombre del repositorio no puede ser solo un prefijo.
  assert.equal(pointsAtRepo("https://github.com/acme/widgets-demo", "acme", "widgets"), false);

  // Otro dominio que lleva la ruta en el path no cuenta.
  assert.equal(pointsAtRepo("https://example.com/github.com/acme/widgets", "acme", "widgets"), false);
  assert.equal(pointsAtRepo("https://evil.example/acme/widgets", "acme", "widgets"), false);

  // Texto libre tampoco.
  assert.equal(pointsAtRepo("financiado para acme/widgets", "acme", "widgets"), false);
});

test("pointsAtIssue distingue #1 de #10 y trata el punto del owner como literal", () => {
  assert.equal(pointsAtIssue("https://github.com/acme/widgets/issues/1", "acme", "widgets", 1), true);
  assert.equal(pointsAtIssue("https://github.com/acme/widgets/issues/10", "acme", "widgets", 1), false);

  assert.equal(pointsAtIssue("https://github.com/a.b/r/issues/1", "a.b", "r", 1), true);
  assert.equal(pointsAtIssue("https://github.com/axb/r/issues/1", "a.b", "r", 1), false);
});

test("LINEA_BOUNTY acepta CRLF, no salta de línea e ignora menciones en medio de una frase", () => {
  assert.equal(LINEA_BOUNTY.test("Bounty: #12\r\n"), true);
  assert.equal(LINEA_BOUNTY.test("Bounty: #12"), true);

  // No debe aceptar "Bounty:" en una línea y el número en la siguiente.
  assert.equal(LINEA_BOUNTY.test("Bounty:\n#12"), false);
  assert.equal(LINEA_BOUNTY.test("Bounty: \r\n#12"), false);

  // Una mención dentro de una frase no es una línea de bounty.
  assert.equal(LINEA_BOUNTY.test("Esto no es Bounty: #12"), false);
});

test("closedIssues reconoce todas las formas de close, fix y resolve", () => {
  const cuerpo = `
close #1
closes #2
closed #3
fix #4
fixes #5
fixed #6
resolve #7
resolves #8
resolved #9
Close: #10
`;

  assert.deepEqual(closedIssues(cuerpo), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("bountyForIssue devuelve el único bounty vivo que apunta al issue", () => {
  const ahora = 1_700_000_000_000;
  const futuro = Math.floor(ahora / 1000) + 3600;
  const bounty = {
    id: "1",
    uri: "https://github.com/acme/widgets/issues/7",
    funder: "0xaaa",
    verifier: "0xver",
    closed: false,
    deadline: futuro,
  };

  const resultado = bountyForIssue({
    bounties: [bounty],
    owner: "acme",
    repo: "widgets",
    issue: 7,
    verifier: "0xVER",
    now: ahora,
  });

  assert.deepEqual(resultado, { bounty });
});

test("bountyForIssue explica cuando no hay ningún bounty que apunte al issue", () => {
  const ahora = 1_700_000_000_000;
  const futuro = Math.floor(ahora / 1000) + 3600;
  const bounty = {
    id: "1",
    uri: "https://github.com/acme/widgets/issues/8",
    funder: "0xaaa",
    verifier: "0xver",
    closed: false,
    deadline: futuro,
  };

  const resultado = bountyForIssue({
    bounties: [bounty],
    owner: "acme",
    repo: "widgets",
    issue: 7,
    now: ahora,
  });

  assert.equal(resultado.bounty, undefined);
  assert.match(resultado.reason, /no open bounty points at issue #7/);
});

test("bountyForIssue devuelve ambigüedad y ningún bounty cuando hay dos candidatos", () => {
  const ahora = 1_700_000_000_000;
  const futuro = Math.floor(ahora / 1000) + 3600;
  const bounties = [
    {
      id: "1",
      uri: "https://github.com/acme/widgets/issues/7",
      funder: "0xaaa",
      verifier: "0xver",
      closed: false,
      deadline: futuro,
    },
    {
      id: "2",
      uri: "https://github.com/acme/widgets/issues/7",
      funder: "0xbbb",
      verifier: "0xver",
      closed: false,
      deadline: futuro,
    },
  ];

  const resultado = bountyForIssue({
    bounties,
    owner: "acme",
    repo: "widgets",
    issue: 7,
    now: ahora,
  });

  assert.equal(resultado.bounty, undefined);
  assert.equal(resultado.ambiguous.length, 2);
  assert.match(resultado.reason, /2 open bounties point at issue #7/);
  assert.match(resultado.reason, /#1, #2/);
});

test("bountyForIssue usa funders para estrechar los candidatos", () => {
  const ahora = 1_700_000_000_000;
  const futuro = Math.floor(ahora / 1000) + 3600;
  const bounties = [
    {
      id: "1",
      uri: "https://github.com/acme/widgets/issues/7",
      funder: "0xaaa",
      verifier: "0xver",
      closed: false,
      deadline: futuro,
    },
    {
      id: "2",
      uri: "https://github.com/acme/widgets/issues/7",
      funder: "0xbbb",
      verifier: "0xver",
      closed: false,
      deadline: futuro,
    },
  ];

  const resultado = bountyForIssue({
    bounties,
    owner: "acme",
    repo: "widgets",
    issue: 7,
    funders: ["0xAAA"],
    now: ahora,
  });

  assert.deepEqual(resultado, { bounty: bounties[0] });
});

test("logsOf sigue next_page_params y decodifica todas las páginas", async () => {
  const fetchOriginal = globalThis.fetch;
  const urls = [];

  const pagina1 = {
    items: [
      evento({
        metodo: "BountyPosted(uint256,address,address,uint256,uint256,string)",
        parametros: {
          bountyId: "1",
          funder: "0xaaa",
          verifier: "0xbbb",
          amount: "100",
          deadline: "123",
          metadataURI: "https://github.com/acme/widgets/issues/7",
        },
        tx: "0xaaa",
      }),
      { decoded: null },
    ],
    next_page_params: { page: "2", size: "50" },
  };

  const pagina2 = {
    items: [
      evento({
        metodo: "BountySettled(uint256,address,uint256,uint256,bytes32)",
        parametros: {
          bountyId: "1",
          developer: "0xccc",
          paidToDeveloper: "90",
          protocolFee: "10",
          evidenceHash: "0xddd",
        },
        tx: "0xbbb",
      }),
    ],
    next_page_params: null,
  };

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return respuestaJson(pagina1);
    return respuestaJson(pagina2);
  };

  try {
    const eventos = await logsOf("0x1234");

    assert.equal(urls.length, 2);
    assert.match(urls[0], /\/api\/v2\/addresses\/0x1234\/logs$/);
    assert.match(urls[1], /\?page=2&size=50$/);

    assert.equal(eventos.length, 2);
    assert.deepEqual(eventos[0], {
      kind: "BountyPosted",
      tx: "0xaaa",
      bountyId: "1",
      funder: "0xaaa",
      verifier: "0xbbb",
      amount: "100",
      deadline: "123",
      metadataURI: "https://github.com/acme/widgets/issues/7",
    });
    assert.deepEqual(eventos[1], {
      kind: "BountySettled",
      tx: "0xbbb",
      bountyId: "1",
      developer: "0xccc",
      paidToDeveloper: "90",
      protocolFee: "10",
      evidenceHash: "0xddd",
    });
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("logsOf lanza si una página falla y no devuelve una lista a medias", async () => {
  const fetchOriginal = globalThis.fetch;
  let llamadas = 0;

  globalThis.fetch = async () => {
    llamadas += 1;
    if (llamadas === 1) {
      return respuestaJson({
        items: [],
        next_page_params: { page: "2" },
      });
    }
    return respuestaJson({}, { ok: false, status: 503 });
  };

  try {
    await assert.rejects(
      () => logsOf("0x1234"),
      /explorer answered 503/,
    );
    assert.equal(llamadas, 2);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
