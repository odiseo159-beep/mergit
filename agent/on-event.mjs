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
//   - mergit.json en la rama principal: el registro de wallets de los autores.
//     El pago va a la wallet registrada del autor del PR, no a una dirección
//     que el agente elija.
//
// Variables de entorno (las pone el workflow):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH
//   MERGIT_AGENT_KEY  clave del agente. Sin ella, todo corre en modo ensayo.
import { readFileSync, appendFileSync } from "node:fs";
import { formatEther } from "viem";
import { settleBounty } from "./settle.mjs";

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
let sha;
if (EVENT === "push") sha = payload.after;
else if (EVENT === "workflow_run") sha = payload.workflow_run.head_sha;
else if (EVENT === "workflow_dispatch") sha = null;
else {
  say(`Mergit: ignoring event \`${EVENT}\`.`);
  process.exit(0);
}

// ─────────────────── 2. ¿Qué pull requests toca ese commit? ───────────

let prs;
if (EVENT === "workflow_dispatch") {
  const n = Number(payload.inputs?.pr);
  prs = n ? [await gh(`/repos/${REPO}/pulls/${n}`)] : [];
} else {
  prs = await gh(`/repos/${REPO}/commits/${sha}/pulls`);
}
if (!prs.length) {
  say(`Mergit: no pull request is associated with \`${sha?.slice(0, 7)}\`. Nothing to do.`);
  finish();
}

const repoInfo = await gh(`/repos/${REPO}`);
const registry = await loadRegistry(repoInfo.default_branch);

for (const pr of prs) {
  const tag = `#${pr.number}`;
  const bountyMatch = (pr.body ?? "").match(/^\s*bounty:\s*#?(\d+)\s*$/im);
  if (!bountyMatch) {
    say(`${tag}: no \`Bounty: #N\` line in the description. Not a bounty.`);
    continue;
  }
  const bountyId = bountyMatch[1];
  const author = pr.user.login;
  const developer = registry[author.toLowerCase()];
  if (!developer) {
    say(`${tag}: @${author} has no wallet in \`mergit.json\`. Not paid.`);
    if (pr.merged_at) await comment(pr.number, `**Mergit did not pay this pull request.** @${author} has no registered wallet in \`mergit.json\`, so there is nowhere to send bounty #${bountyId}. Add one and re-run the workflow.`);
    continue;
  }

  const r = await settleBounty({ bountyId, target: { owner: OWNER, repo: NAME, number: pr.number }, developer, send: SEND });
  const v = r.verdict;

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
    say(`${tag}: verified. Would pay ${formatEther(r.payout)} ETH to ${developer} (dry run: no MERGIT_AGENT_KEY).`);
    continue;
  }

  // Pagado.
  say(`${tag}: PAID ${formatEther(r.event.paidToDeveloper)} ETH to ${developer}. ${r.url}`);
  await comment(pr.number, [
    `**Mergit paid this pull request.**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Bounty | #${bountyId} |`,
    `| Paid to | \`${developer}\`, @${author}'s registered wallet |`,
    `| Amount | ${formatEther(r.event.paidToDeveloper)} ETH (protocol fee ${formatEther(r.event.protocolFee)} ETH) |`,
    `| Verified | merged, CI green on head commit \`${v.evidence.headSha.slice(0, 7)}\` |`,
    `| Evidence hash | \`${r.event.evidenceHash}\` |`,
    `| Transaction | [${r.tx.slice(0, 10)}…${r.tx.slice(-4)}](${r.url}) on GIWA Sepolia |`,
    ``,
    `Merge it. Get paid.`,
  ].join("\n"));
}

finish();

// ─────────────────────────────── Utilidades ─────────────────────────

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
