// Lo que el servidor MCP sabe hacer, sin el transporte. Cada función devuelve
// datos simples (JSON), y `server.mjs` solo las expone como herramientas.
//
// ───────────────────────────── La regla ──────────────────────────────
//
// **Nada aquí firma, ni guarda una clave, ni mueve fondos.** La IA de quien usa
// esto prepara; el humano firma en su propia wallet, en mergit.xyz. Es la misma
// regla de AGENTS.md, y un test (`test/sin-claves.test.mjs`) falla si alguien
// mete aquí algo que suene a clave.
//
// ⚠️ Las decisiones (qué bounty paga un pull request, a qué wallet) **se importan
// de `agent/`, no se repiten**. Es lo que hace el preflight, por la misma razón:
// una herramienta que le dice a alguien "esto va a cobrar" y un agente que
// después no paga es peor que no tener herramienta.
import {
  listBounties, isLive, closedIssues, bountyForIssue, pointsAtRepo, pointsAtIssue,
  settlementOf, LINEA_BOUNTY,
} from "../agent/bounties.mjs";
import { verifyPullRequest, PAYABLE_CONTEXT, PREFLIGHT_CHECK } from "../agent/verify.mjs";
import { resolveWallet } from "../agent/registry.mjs";
import { publicClient, ABI, ABI_V2, STATUS, STATUS_V2, parseTarget } from "../agent/chain.mjs";

export const SITE = "https://www.mergit.xyz";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
/** El agente de Mergit: el verificador que paga solo al mergear. */
export const AGENT = "0x28df38871ef4beebd6b0d8cd6d4c99bf4fe3852b";
/**
 * Los escrows que lee esto. La v1 es donde liquida el agente y donde corre la
 * campaña; la v2 es la de la ventana de objeción que ofrece /post. La v3 y la v4
 * solo tienen pagos de prueba internos, y por eso no se listan.
 */
export const ESCROWS = {
  v1: { address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879", abi: ABI, status: STATUS },
  v2: { address: "0x48d506080abdbed11f1acbe40f799301d9612ad5", abi: ABI_V2, status: STATUS_V2 },
};
/**
 * El registro de identidad. `agent/registry.mjs` lo lee de
 * `contracts/registry.json`, que no viaja en el paquete de npm: sin esto, el
 * paquete no vería ninguna reclamación y diría que nadie puede cobrar por el
 * registro. Se fija aquí, y quien quiera otro puede definir MERGIT_REGISTRY.
 */
export const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
process.env.MERGIT_REGISTRY ||= REGISTRY;
/** El escrow donde paga el agente si el repositorio no dice otro. */
const ESCROW_DEL_AGENTE = "v1";

// ─────────────────────────────── Ayudas ───────────────────────────────

/** Wei a ETH en texto, sin perder decimales y sin depender de viem. */
export function eth(wei) {
  const s = BigInt(wei).toString().padStart(19, "0");
  const entero = s.slice(0, -18);
  const decimales = s.slice(-18).replace(/0+$/, "");
  return decimales ? `${entero}.${decimales}` : entero;
}

/** ETH en texto a wei. Solo cifras y un punto: nada de notación científica. */
export function wei(texto) {
  const t = String(texto).trim();
  if (!/^\d*\.?\d+$/.test(t)) throw new Error(`"${texto}" is not an amount in ETH`);
  const [entero, dec = ""] = t.split(".");
  if (dec.length > 18) throw new Error("more than 18 decimals");
  return BigInt(entero || "0") * 10n ** 18n + BigInt(dec.padEnd(18, "0"));
}

const ISSUE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i;

/** `{ owner, repo, number }` si el texto es el enlace a un issue de GitHub; si no, null. */
export function parseIssue(uri) {
  const m = String(uri || "").trim().match(ISSUE);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "mergit-mcp" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch("https://api.github.com" + path, { headers });
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) {
    throw new Error("GitHub rate-limited this machine (60 requests an hour without a token). Set GITHUB_TOKEN in the MCP server's environment, or wait.");
  }
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
}

/** Un archivo del repositorio por el CDN, que no gasta la cuota de la API. */
async function raw(owner, repo, path) {
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`);
  return r.ok ? r.text() : null;
}

// ─────────────────────────── 1 · Bounties abiertos ───────────────────────────

/**
 * Los bounties vivos que apuntan a un issue de GitHub.
 *
 * Deja fuera, y lo dice, los que apuntan a otra cosa (un repo sin issue,
 * `owner/repo/issues/7`, un texto): financiar es abierto y la cadena los acepta,
 * pero nadie puede cerrarlos con un pull request.
 */
export async function listOpenBounties({ repo } = {}, { now = Date.now(), bounties } = {}) {
  const todos = bounties ?? await listBounties();
  const vivos = todos.filter((b) => isLive(b, now));

  let sinIssue = 0;
  const out = [];
  for (const b of vivos) {
    const issue = parseIssue(b.uri);
    if (!issue || issue.owner.toLowerCase() === "owner") { sinIssue++; continue; }
    const slug = `${issue.owner}/${issue.repo}`;
    if (repo && slug.toLowerCase() !== String(repo).toLowerCase()) continue;
    const delAgente = b.verifier === AGENT;
    out.push({
      bounty: Number(b.id),
      escrow: b.escrow,
      escrow_address: b.address,
      issue: `https://github.com/${slug}/issues/${issue.number}`,
      repository: slug,
      reward_eth: eth(b.amount),
      deadline: new Date(b.deadline * 1000).toISOString(),
      days_left: Math.floor((b.deadline * 1000 - now) / 86400000),
      funder: b.funder,
      verifier: b.verifier,
      verifier_is_mergit_agent: delAgente,
      paid_automatically_on_merge: delAgente && b.escrow === ESCROW_DEL_AGENTE,
      line_for_the_pull_request: `Bounty: #${b.id}`,
    });
  }

  // En la v2 un pago propuesto queda `Pending` y la lista de eventos lo sigue
  // viendo abierto. Se pregunta a la cadena solo por esos, que son pocos.
  for (const b of out.filter((x) => x.escrow === "v2")) {
    try {
      const on = await publicClient.readContract({
        address: ESCROWS.v2.address, abi: ESCROWS.v2.abi, functionName: "getBounty", args: [BigInt(b.bounty)],
      });
      if (STATUS_V2[on.status] !== "Open") b.pending = STATUS_V2[on.status];
    } catch { /* si no responde, se queda como estaba */ }
  }
  const abiertos = out.filter((b) => !b.pending).sort((a, b) => a.days_left - b.days_left);
  // Dos bounties sobre el mismo issue: cerrar el issue no alcanza para elegir
  // (`bountyForIssue` se niega), así que el pull request tiene que nombrar uno.
  const porIssue = new Map();
  for (const b of abiertos) porIssue.set(b.issue, (porIssue.get(b.issue) ?? 0) + 1);
  for (const b of abiertos) {
    if (porIssue.get(b.issue) > 1) b.note = "More than one open bounty points at this issue: the pull request must name this one with its `Bounty: #N` line.";
  }

  return {
    open: abiertos,
    count: abiertos.length,
    total_reward_eth: eth(abiertos.reduce((s, b) => s + wei(b.reward_eth), 0n)),
    hidden_without_a_github_issue: sinIssue,
    how_to_take_one: "Open a pull request on that repository that fixes the issue, with the line `Bounty: #N` (or `Closes #<issue>`) in its description. The author's GitHub login must resolve to a wallet first: see mergit_payout_setup. Payment happens when a maintainer merges it with CI green.",
    chain: "GIWA Sepolia (testnet, chain id 91342). Test ETH, real on-chain record.",
  };
}

// ─────────────────────────── 2 · Un bounty ───────────────────────────

export async function getBounty({ id, escrow = "v1" }) {
  const e = ESCROWS[escrow];
  if (!e) throw new Error(`unknown escrow "${escrow}": use v1 or v2`);
  const on = await publicClient.readContract({ address: e.address, abi: e.abi, functionName: "getBounty", args: [BigInt(id)] });
  const status = e.status[on.status] ?? String(on.status);
  if (status === "None") return { bounty: Number(id), escrow, status: "does not exist" };

  const evento = (await listBounties({ address: e.address })).find((b) => b.id === String(id));
  const out = {
    bounty: Number(id),
    escrow,
    escrow_address: e.address,
    status,
    task_as_stated_by_funder: evento?.uri ?? null,
    points_at_a_github_issue: Boolean(parseIssue(evento?.uri)),
    reward_eth: eth(on.amount),
    deadline: new Date(Number(on.deadline) * 1000).toISOString(),
    funder: on.funder.toLowerCase(),
    verifier: on.verifier.toLowerCase(),
    verifier_is_mergit_agent: on.verifier.toLowerCase() === AGENT,
    explorer: `${EXPLORER}/address/${e.address}`,
  };
  if (status === "Settled") {
    const s = await settlementOf(e.address, id);
    if (s) {
      out.paid = {
        to: s.developer,
        paid_to_developer_eth: eth(s.paidToDeveloper),
        protocol_fee_eth: eth(s.protocolFee),
        evidence_hash: s.evidenceHash,
        transaction: `${EXPLORER}/tx/${s.tx}`,
      };
    }
  }
  return out;
}

// ─────────────────────── 3 · ¿Este pull request cobra? ───────────────────────

/** El CI del commit, sin el preflight de Mergit, que no es CI (ver agent/verify.mjs). */
async function ciAhora(owner, repo, sha) {
  const [runs, combined] = await Promise.all([
    gh(`/repos/${owner}/${repo}/commits/${sha}/check-runs`),
    gh(`/repos/${owner}/${repo}/commits/${sha}/status`),
  ]);
  const todos = [
    ...((runs?.check_runs) ?? []).filter((c) => c.name !== PREFLIGHT_CHECK)
      .map((c) => ({ name: c.name, state: c.status === "completed" ? c.conclusion : c.status })),
    ...((combined?.statuses) ?? []).filter((s) => s.context !== PAYABLE_CONTEXT)
      .map((s) => ({ name: s.context, state: s.state })),
  ];
  if (!todos.length) {
    // Un fork que manda su primer pull request: GitHub no corre el CI hasta que
    // un mantenedor lo aprueba, y el commit queda sin checks. No es "sin CI".
    const suites = await gh(`/repos/${owner}/${repo}/commits/${sha}/check-suites`).catch(() => null);
    if ((suites?.check_suites ?? []).some((x) => x.conclusion === "action_required")) {
      return { state: "awaiting_approval", detail: "CI has not run yet: GitHub is waiting for a maintainer to approve the workflow run for this contributor (Actions tab, Approve and run)" };
    }
    return { state: "none", detail: "this commit reports no CI, and no CI is not CI passing: the agent will not pay" };
  }
  const ok = new Set(["success", "neutral", "skipped"]);
  const pendientes = todos.filter((c) => ["queued", "in_progress", "pending", "waiting", "requested"].includes(c.state));
  if (pendientes.length) return { state: "running", detail: `still running: ${pendientes.map((c) => c.name).join(", ")}` };
  const rotos = todos.filter((c) => !ok.has(c.state));
  if (rotos.length) return { state: "failing", detail: `failing: ${rotos.map((c) => c.name).join(", ")}` };
  return { state: "green", detail: `${todos.length} checks green` };
}

/** ¿El repositorio tiene el workflow que despierta al agente al mergear? */
async function tieneWorkflow(owner, repo) {
  const dir = await gh(`/repos/${owner}/${repo}/contents/.github/workflows`).catch(() => null);
  if (!Array.isArray(dir)) return false;
  for (const f of dir.filter((x) => /\.ya?ml$/i.test(x.name))) {
    const texto = await raw(owner, repo, f.path);
    if (texto && /odiseo159-beep\/mergit|on-event\.mjs/i.test(texto)) return true;
  }
  return false;
}

/**
 * Responde lo que el autor y el mantenedor quieren saber antes de mergear:
 * ¿esto va a pagar, cuánto y a quién? Con las mismas reglas que usa el agente
 * (`agent/on-event.mjs`), en el escrow donde liquida el agente.
 */
export async function checkPullRequest({ pull_request }) {
  const t = parseTarget(pull_request);
  if (!t) throw new Error("give a pull request as https://github.com/owner/repo/pull/123 or owner/repo#123");
  const { owner, repo, number } = t;

  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  if (!pr) throw new Error(`${owner}/${repo}#${number} does not exist or is private`);
  const author = pr.user?.login;
  const body = pr.body ?? "";
  const linea = body.match(LINEA_BOUNTY);
  const cierra = closedIssues(body);

  const escrow = ESCROWS[ESCROW_DEL_AGENTE];
  const catalogo = await listBounties({ address: escrow.address });
  const conf = JSON.parse((await raw(owner, repo, "mergit.json")) || "{}");
  const funders = Array.isArray(conf.funders) ? conf.funders.map((x) => String(x).toLowerCase()) : [];
  const enArchivo = Object.fromEntries(Object.entries(conf.wallets ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  const out = {
    pull_request: `https://github.com/${owner}/${repo}/pull/${number}`,
    author,
    state: pr.merged ? "merged" : pr.state,
    bounty: null,
    wallet: null,
    ci: null,
    blockers: [],
    notes: [],
  };

  // 0 · ¿ya cobró? Mismo criterio que el agente: la evidencia grabada en el pago
  //     tiene que ser idéntica a la de este pull request.
  if (pr.merged) {
    const pagados = catalogo.filter((b) => b.closed
      && (b.id === linea?.[1] || cierra.some((n) => pointsAtIssue(b.uri, owner, repo, n))));
    if (pagados.length) {
      const propia = await verifyPullRequest({ owner, repo, number }).catch(() => null);
      for (const b of pagados) {
        const s = await settlementOf(escrow.address, b.id).catch(() => null);
        if (s && propia && s.evidenceHash === String(propia.evidenceHash).toLowerCase()) {
          return {
            ...out,
            verdict: "already_paid",
            summary: `Already paid: bounty #${b.id}, ${eth(s.paidToDeveloper)} ETH to ${s.developer}.`,
            bounty: { id: Number(b.id), escrow: ESCROW_DEL_AGENTE, reward_eth: eth(b.amount), issue: b.uri },
            paid: { to: s.developer, paid_to_developer_eth: eth(s.paidToDeveloper), transaction: `${EXPLORER}/tx/${s.tx}` },
          };
        }
      }
    }
  }

  // 1 · el bounty: la línea `Bounty: #N` si vale aquí, o el issue que cierra.
  let elegido = null;
  if (linea) {
    const pedido = catalogo.find((b) => b.id === linea[1]);
    if (!pedido) out.notes.push(`Bounty #${linea[1]} does not exist on the escrow the agent pays from.`);
    else if (!isLive(pedido)) out.notes.push(`Bounty #${linea[1]} is no longer open (paid, refunded or past its deadline).`);
    else if (pedido.verifier !== AGENT) out.notes.push(`Bounty #${linea[1]} names another verifier, so Mergit's agent will not settle it.`);
    else if (!pointsAtRepo(pedido.uri, owner, repo)) out.notes.push(`Bounty #${linea[1]} was funded for work outside ${owner}/${repo}, so its line does not count here.`);
    else elegido = pedido;
  }
  if (!elegido) {
    for (const n of cierra) {
      const r = bountyForIssue({ bounties: catalogo, owner, repo, issue: n, verifier: AGENT, funders });
      if (r.bounty) { elegido = r.bounty; out.notes.push(`Bounty resolved from "Closes #${n}".`); break; }
      out.notes.push(r.reason);
      if (r.ambiguous) break;
    }
  }
  if (elegido) {
    out.bounty = {
      id: Number(elegido.id),
      escrow: ESCROW_DEL_AGENTE,
      reward_eth: eth(elegido.amount),
      issue: elegido.uri,
      deadline: new Date(elegido.deadline * 1000).toISOString(),
    };
  } else {
    out.blockers.push(linea || cierra.length
      ? "No open bounty that Mergit's agent pays matches this pull request."
      : "The description has no `Bounty: #N` line and closes no issue with a bounty behind it.");
  }

  // 2 · la wallet del autor, en el orden del agente: registro, README de perfil, mergit.json.
  try {
    const who = await resolveWallet(author, enArchivo[author.toLowerCase()], process.env.GITHUB_TOKEN);
    if (who.wallet) out.wallet = { address: who.wallet.toLowerCase(), source: who.source, proof: who.proof ?? null };
    else out.blockers.push(`No wallet to pay: ${who.reason}. Fix it with mergit_payout_setup.`);
  } catch (e) {
    out.blockers.push(`Could not check the author's wallet: ${e.message}`);
  }

  // 3 · el CI del commit entregado.
  out.ci = await ciAhora(owner, repo, pr.head.sha).catch((e) => ({ state: "unknown", detail: e.message }));
  if (["none", "failing", "awaiting_approval"].includes(out.ci.state)) out.blockers.push(`CI: ${out.ci.detail}.`);

  // 4 · el workflow que despierta al agente.
  const wf = await tieneWorkflow(owner, repo).catch(() => null);
  if (wf === false) out.blockers.push(`${owner}/${repo} has no Mergit workflow, so a merge wakes nothing. See ${SITE}/start.`);

  if (pr.merged) {
    out.verdict = out.blockers.length ? "merged_not_paid" : "merged_payment_due";
    out.summary = out.blockers.length
      ? "Merged, and nothing will pay it as things stand."
      : "Merged with everything in place. If no receipt was commented, a maintainer can re-run the Mergit workflow by hand.";
  } else if (pr.state === "closed") {
    out.verdict = "closed_without_merge";
    out.summary = "Closed without merging. Nothing is paid for work that is not merged.";
  } else if (out.blockers.length) {
    out.verdict = "would_not_pay";
    out.summary = "Merging this now would NOT pay. Fix the blockers first.";
  } else {
    out.verdict = out.ci.state === "green" ? "would_pay" : "would_pay_once_ci_is_green";
    out.summary = `Merging pays bounty #${out.bounty.id}: ${out.bounty.reward_eth} ETH minus the 1.5% fee to ${out.wallet.address}, a few seconds after the merge.`;
  }
  return out;
}

// ─────────────────────────── 4 · El historial de un builder ───────────────────────────

/**
 * Lo mismo que /p/<login> y el badge, de `/record/<login>.json`: no cuenta lo que
 * una wallet se pagó a sí misma ni las pruebas de julio.
 */
export async function builderRecord({ login }) {
  if (!LOGIN.test(String(login))) throw new Error(`"${login}" is not a GitHub login`);
  const r = await fetch(`${SITE}/record/${login}.json`);
  if (r.status === 404) return { login, found: false, how_to_start: "mergit_payout_setup" };
  if (!r.ok) throw new Error(`${SITE} answered ${r.status}`);
  const d = await r.json();
  return {
    login: d.login,
    wallet: d.wallet ?? null,
    wallet_source: d.source ?? null,
    bounties_paid: d.totals?.bountiesPaid ?? 0,
    eth_paid: eth(d.totals?.weiPaid ?? "0"),
    distinct_funders: d.totals?.distinctFunders ?? 0,
    self_funded_not_counted: d.totals?.selfFundedNotCounted ?? 0,
    payments: (d.payments ?? []).map((p) => ({
      bounty: p.bountyId,
      escrow: p.escrow,
      task: p.taskAsStatedByFunder,
      eth: eth(p.paidToDeveloperWei),
      at: p.at,
      transaction: `${EXPLORER}/tx/${p.transaction}`,
    })),
    page: `${SITE}/p/${d.login}`,
  };
}

// ─────────────────────── 5 · Preparar un bounty (firma el humano) ───────────────────────

/**
 * El enlace de /post para financiar un issue, avisando antes si ya tiene bounty.
 *
 * Un bounty por issue: se mira la cadena antes de dar el enlace, para no
 * mandar al financiador a pagar dos veces lo mismo (el 26 de noviembre pasó
 * con dos bounties a 15 segundos). Se lee escrow por escrow con `address`,
 * porque sin él `listBounties` se traga el fallo de un escrow y la lista sale
 * incompleta sin que nadie lo note; aquí incompleto es no saber. Si la cadena
 * no responde, el enlace sale igual y lo dice, con `already_funded: null`.
 */
export async function fundLink({ issue_url, amount_eth = "0.0005" }) {
  const issue = parseIssue(issue_url);
  if (!issue) throw new Error("a bounty pays for one GitHub issue: give a link like https://github.com/owner/repo/issues/12");
  const monto = eth(wei(amount_eth));
  if (wei(monto) === 0n) throw new Error("the amount must be more than zero");
  const uri = `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`;
  const link = `${SITE}/post?` + new URLSearchParams({ uri, amount: monto }).toString();

  let ya = null;
  try {
    const todos = [];
    for (const e of Object.values(ESCROWS)) todos.push(...await listBounties({ address: e.address }));
    ya = todos
      .filter((b) => isLive(b) && pointsAtIssue(b.uri, issue.owner, issue.repo, issue.number))
      .map((b) => ({
        bounty: Number(b.id),
        escrow: b.escrow,
        reward_eth: eth(b.amount),
        deadline: new Date(b.deadline * 1000).toISOString(),
      }));
  } catch {
    ya = null;
  }

  const out = {
    link,
    issue: uri,
    reward_eth: monto,
    already_funded: ya,
    who_signs: "The user, in their own wallet, on that page. Do not try to sign or send this transaction yourself.",
    what_the_page_does: "Checks that the repository can pay (Mergit workflow, CI), then locks the ETH in the escrow on GIWA Sepolia and returns the `Bounty: #N` line to paste in the pull request.",
    before_funding: [
      "The issue should state what done looks like as facts a machine can check (tests that pass, a function that returns X). Use the prompt `write_bounty_spec`.",
      "Label the issue `bounty` so it shows in the lists.",
      `If the repository is not connected yet: ${SITE}/start`,
    ],
  };
  if (ya?.length) {
    const cuales = ya.map((b) => `Bounty: #${b.bounty} (${b.reward_eth} ETH, escrow ${b.escrow})`).join(", ");
    out.warning = `This issue already has a live bounty: ${cuales}. One bounty per issue: fund another issue instead.`;
  } else if (ya === null) {
    out.note = "Could not read the chain, so this could not check whether the issue already has a live bounty. The /post page warns before funding an issue that already has one.";
  }
  return out;
}

// ─────────────────────── 6 · Poder cobrar ───────────────────────

export async function payoutSetup({ login, wallet }) {
  if (!LOGIN.test(String(login))) throw new Error(`"${login}" is not a GitHub login`);
  if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error(`"${wallet}" is not an address`);

  const who = await resolveWallet(login, null, process.env.GITHUB_TOKEN).catch((e) => ({ source: "unknown", reason: e.message }));
  const listo = Boolean(who.wallet);
  return {
    login,
    can_be_paid_now: listo,
    current: listo ? { wallet: who.wallet.toLowerCase(), source: who.source, proof: who.proof ?? null } : { reason: who.reason },
    options: [
      {
        name: "profile README (no signature, no gas)",
        steps: [
          `Edit the README of the repository github.com/${login}/${login} (the one GitHub shows on the profile page).`,
          `Add one line that names Mergit and has the wallet: \`Mergit payouts: ${wallet ?? "0xYOUR_WALLET"}\``,
          "Only one address may appear on lines that mention Mergit, or the agent will not guess.",
        ],
      },
      {
        name: "on-chain registry (signed once, wins over everything else)",
        steps: [`Open ${SITE}/register and follow it. The user's wallet signs; the page checks the proof against GitHub first.`],
      },
    ],
    note: "Never paste a private key or seed phrase anywhere for this. Neither option needs one.",
  };
}

// ─────────────────────── La guía para escribir un bounty ───────────────────────

export const BOUNTY_SPEC_PROMPT = `Write a bounty specification for this GitHub issue so that "done" is a fact, not an opinion. Produce four parts:

1. The change, in one sentence: what must be true afterwards that is not true now.
2. Acceptance criteria a machine can evaluate. Not "clean code" or "good performance". Things like: \`npm test\` passes, including a new test named X; the function Y returns Z for input W; the endpoint /health answers 200; no new dependency is added.
3. What is out of scope. The most common reason a bounty ends in an argument is that the contributor solved a bigger problem than the funder wanted to pay for.
4. Where the work goes: the repository, the branch, the paths that may change.

Keep it short. Then offer the funding link from mergit_fund_link. The user signs; you never do.`;
