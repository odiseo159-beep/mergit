// Mergit dentro de GitHub Actions: el merge dispara el pago sin que nadie
// escriba un comando.
//
// Corre en el repositorio que publica bounties, ante dos eventos:
//   - push a main           → acaba de mergearse algo
//   - workflow_run de "CI"   → terminaron las pruebas de algún commit
// Los dos pueden llegar en cualquier orden, así que cada corrida re-verifica
// desde cero y deja que verify.mjs decida. Si el PR aún no está mergeado o el
// CI sigue corriendo, sale en silencio: el siguiente evento lo intentará de nuevo.
// Si el bounty ya se pagó, también sale en silencio.
//
// Qué lee:
//   - el cuerpo del PR, una línea "Bounty: #N" que dice qué bounty cobra
//   - el registro on-chain (MergitRegistry): si el autor reclamó su login desde
//     su wallet, ahí está el destinatario, y el agente comprueba la prueba en
//     GitHub antes de pagar.
//   - mergit.json en la rama principal, para quien todavía no lo reclamó.
//     En los dos casos el destinatario es del autor del PR, no una dirección
//     que el agente elija.
//
// Variables de entorno (las pone el workflow):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH
//   MERGIT_AGENT_KEY  clave del agente. Sin ella, todo corre en modo ensayo.
//   MERGIT_PR         opcional: número de PR a revisar, para una corrida manual.
import { readFileSync, appendFileSync } from "node:fs";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { settleBounty } from "./settle.mjs";
import { resolveWallet, registryAddress } from "./registry.mjs";
import { listBounties, isLive, closedIssues, bountyForIssue } from "./bounties.mjs";

const API = "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const EVENT = process.env.GITHUB_EVENT_NAME;
const SEND = Boolean(process.env.MERGIT_AGENT_KEY);
const [OWNER, NAME] = REPO.split("/");

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mergit-agent",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${path}`);
  return res.status === 204 ? null : res.json();
}

const summary = [];
const say = (line) => {
  console.log(line);
  summary.push(line);
};

// ───────────────────── 1. ¿Qué commit disparó esto? ──────────────────

const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
// Un número de PR pasado a mano gana sobre el evento: sirve para reintentar una corrida.
const asked = Number(process.env.MERGIT_PR || payload.inputs?.pr) || null;
let sha;
if (asked) sha = null;
else if (EVENT === "push") sha = payload.after;
else if (EVENT === "workflow_run") sha = payload.workflow_run.head_sha;
else if (EVENT === "workflow_dispatch") sha = null;
else {
  say(`Mergit: ignoring event \`${EVENT}\`.`);
  process.exit(0);
}

// ─────────────────── 2. ¿Qué pull requests toca ese commit? ───────────

let prs;
if (asked) prs = [await gh(`/repos/${REPO}/pulls/${asked}`)];
else if (EVENT === "workflow_dispatch") prs = [];
else prs = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
if (!prs.length) {
  say(`Mergit: no pull request is associated with \`${sha?.slice(0, 7)}\`. Nothing to do.`);
  finish();
}

const repoInfo = await gh(`/repos/${REPO}`);
const registry = await loadRegistry(repoInfo.default_branch);
const registryFunders = await loadFunders(repoInfo.default_branch);

// Los bounties vivos, una vez por corrida. Sirven para dos cosas: comprobar que
// el número que escribió el autor todavía vale, y resolverlo desde el issue
// cuando no vale o cuando no lo escribió.
let catalogo = [];
try {
  catalogo = await listBounties();
} catch (e) {
  console.log(`(no se pudo leer el catálogo de bounties: ${e.message})`);
}
const verifier = agentAddress();
// Quién puede financiar un bounty que este agente liquide. Sin lista, cualquiera,
// y entonces la única defensa contra un bounty intruso es negarse si hay dos.
const funders = registryFunders;

for (const pr of prs) {
  const tag = `#${pr.number}`;
  const author = pr.user.login;
  const bountyMatch = (pr.body ?? "").match(/^\s*bounty:\s*#?(\d+)\s*$/im);

  let bountyId = null;
  let origen = "";

  // 1 · la línea explícita, si nombra un bounty que sigue vivo y es nuestro
  if (bountyMatch) {
    const pedido = catalogo.find((b) => b.id === bountyMatch[1]);
    if (!catalogo.length) {
      bountyId = bountyMatch[1];
      origen = "the `Bounty: #N` line";
    } else if (pedido && isLive(pedido) && (!verifier || pedido.verifier === verifier.toLowerCase())) {
      bountyId = pedido.id;
      origen = "the `Bounty: #N` line";
    }
  }

  // 2 · el issue que el pull request cierra. El número del bounty es un detalle
  //     del escrow: cambia cada vez que se repone, y el autor no tiene por qué
  //     enterarse. El issue no cambia.
  if (!bountyId && catalogo.length) {
    const issues = closedIssues(pr.body);
    const intentos = [];
    for (const n of issues) {
      const r = bountyForIssue({ bounties: catalogo, owner: OWNER, repo: NAME, issue: n, verifier, funders });
      if (r.bounty) { bountyId = r.bounty.id; origen = `issue #${n}`; break; }
      intentos.push(r.reason);
      if (r.ambiguous) break;   // con ambigüedad no se sigue probando: se para
    }
    if (!bountyId && intentos.length) {
      say(`${tag}: ${intentos[intentos.length - 1]}. Not paid.`);
      if (pr.merged_at) await comment(pr.number, `**Mergit did not pay this pull request.** ${intentos[intentos.length - 1]}.`);
      continue;
    }
  }

  if (!bountyId) {
    say(`${tag}: no \`Bounty: #N\` line and no issue with an open bounty behind it. Not a bounty.`);
    continue;
  }
  if (origen !== "the `Bounty: #N` line") {
    say(`${tag}: bounty #${bountyId} resolved from ${origen}, not from the description.`);
  }

  // El registro on-chain manda; `mergit.json` es el camino viejo, todavía válido
  // mientras el autor no reclame su login.
  const who = await resolveWallet(author, registry[author.toLowerCase()], TOKEN);
  const developer = who.wallet;
  if (!developer) {
    say(`${tag}: ${who.reason}. Not paid.`);
    if (pr.merged_at) await comment(pr.number, `**Mergit did not pay this pull request.** ${who.reason}, so there is nowhere to send bounty #${bountyId}.`);
    continue;
  }
  say(`${tag}: paying @${author} at ${developer} (${who.source === "registry" ? `claimed on-chain, proof in ${who.proof}` : "from mergit.json"}).`);

  const r = await settleBounty({ bountyId, target: { owner: OWNER, repo: NAME, number: pr.number }, developer, send: SEND });
  const v = r.verdict;

  // El pago está aprobado pero corre la ventana de objeción del financiador.
  if (r.stage === "pending") {
    const when = new Date(r.claimableAt * 1000).toISOString().replace("T", " ").slice(0, 19);
    say(`${tag}: settlement proposed, claimable at ${when} UTC. Waiting out the challenge window.`);
    continue;
  }

  // Esperas: otro evento lo reintentará. Sin comentario, para no ensuciar el PR.
  if (r.stage === "verify" && !v.merged) { say(`${tag}: not merged yet. Waiting.`); continue; }
  if (r.stage === "verify" && v.ciPending) { say(`${tag}: CI still running on \`${v.evidence.headSha.slice(0, 7)}\`. Waiting for green.`); continue; }
  if (r.done) { say(`${tag}: bounty #${bountyId} is already ${r.status}. Nothing to do.`); continue; }

  // Rechazos reales: el PR está mergeado pero no se va a pagar.
  if (!r.ok) {
    const why =
      r.stage === "verify" && v.ciGreen === null ? "the repository reports no CI for the pull request's head commit, and missing checks are not passing checks" :
      r.stage === "verify" ? "its CI did not pass on the head commit" :
      r.reason;
    say(`${tag}: not paid. ${why}.`);
    await comment(pr.number, `**Mergit did not pay bounty #${bountyId}:** ${why}.`);
    continue;
  }

  if (r.stage === "dry-run") {
    const what = r.finalizing ? "Would finalize the pending payment of" : "Would pay";
    say(`${tag}: verified. ${what} ${formatEther(r.payout)} ETH to ${developer} (dry run: no MERGIT_AGENT_KEY).`);
    continue;
  }

  // Con ventana de objeción el pago no sale todavía: queda propuesto.
  if (r.stage === "proposed") {
    say(`${tag}: settlement proposed for ${developer}. The funder can challenge it. ${r.url}`);
    await comment(pr.number, [
      `**Mergit approved this pull request.**`,
      ``,
      `Bounty #${bountyId} will pay \`${developer}\` once the challenge window closes. Until then, the funder can object once.`,
      ``,
      `Verified: merged, CI green on \`${v.evidence.headSha.slice(0, 7)}\` · evidence \`${r.verdict.evidenceHash}\` · [transaction](${r.url})`,
    ].join("\n"));
    continue;
  }

  // Pagado.
  say(`${tag}: PAID ${formatEther(r.event.paidToDeveloper)} ETH to ${developer}${r.finalized ? " (finalized after the challenge window)" : ""}. ${r.url}`);
  await comment(pr.number, [
    `**Mergit paid this pull request.**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Bounty | #${bountyId} |`,
    `| Paid to | \`${developer}\` — ${paidVia(who, author)} |`,
    `| Amount | ${formatEther(r.event.paidToDeveloper)} ETH (protocol fee ${formatEther(r.event.protocolFee)} ETH) |`,
    `| Verified | merged, CI green on head commit \`${v.evidence.headSha.slice(0, 7)}\` |`,
    `| Evidence hash | \`${r.event.evidenceHash}\` |`,
    `| Transaction | [${r.tx.slice(0, 10)}…${r.tx.slice(-4)}](${r.url}) on GIWA Sepolia |`,
    ``,
    `Your record: ${SITE}/p/${author}`,
    ``,
    `Put this in your profile README and it will show what your merged work was paid, read straight from the chain:`,
    ``,
    '```markdown',
    `[![Mergit](${SITE}/badge/${author}.svg)](${SITE}/p/${author})`,
    '```',
    ``,
    `Merge it. Get paid.`,
  ].join("\n"));
}

finish();

// ─────────────────────────────── Utilidades ─────────────────────────

/**
 * La dirección con la que este agente firma. Sirve para descartar bounties que
 * nombran a otro verificador: este agente no puede liquidarlos, y proponerlos
 * solo confunde.
 *
 * Sin clave (modo ensayo) se puede fijar con MERGIT_VERIFIER para que el ensayo
 * diga la verdad. Si no hay ninguna de las dos, no se filtra por verificador.
 */
function agentAddress() {
  if (process.env.MERGIT_VERIFIER) return process.env.MERGIT_VERIFIER;
  const key = process.env.MERGIT_AGENT_KEY;
  if (!key) return null;
  try {
    return privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`).address;
  } catch {
    return null;
  }
}

/**
 * Los financiadores que este repositorio acepta, de `mergit.json`:
 *
 *     { "funders": ["0x23E8…7686"] }
 *
 * Financiar es abierto, así que cualquiera puede publicar un bounty de 1 wei
 * apuntando a un issue nuestro para crear una ambigüedad que bloquee el pago.
 * Con la lista, ese bounty intruso no entra en la cuenta. Sin lista, la única
 * defensa es que el agente se niegue cuando hay más de uno, que es lo que hace.
 */
async function loadFunders(branch) {
  try {
    const file = await gh(`/repos/${REPO}/contents/mergit.json?ref=${branch}`);
    const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    const l = json.funders ?? [];
    return Array.isArray(l) ? l.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

async function loadRegistry(branch) {
  try {
    const file = await gh(`/repos/${REPO}/contents/mergit.json?ref=${branch}`);
    const json = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    return Object.fromEntries(Object.entries(json.wallets ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

async function comment(number, body) {
  if (!TOKEN) return;
  try {
    await gh(`/repos/${REPO}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }), headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.log(`(could not comment on #${number}: ${e.message})`);
  }
}

function finish() {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mergit\n\n${summary.map((l) => `- ${l}`).join("\n")}\n`);
  process.exit(0);
}


const SITE = "https://www.mergit.xyz";

/**
 * De donde salio la direccion que cobro. Son tres fuentes y hay que nombrarlas
 * distinto: decir "mergit.json" cuando el pago vino del README de perfil es
 * mentir justo en el sitio donde el recibo tiene que ser exacto.
 */
function paidVia(who, author) {
  if (who.source === "registry") return `registered on-chain by @${author}, proof in ${who.proof}`;
  if (who.source === "profile") return `@${author}'s profile README`;
  return `@${author}'s wallet in \`mergit.json\``;
}