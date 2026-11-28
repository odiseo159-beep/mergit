// Vigilante central de Mergit: paga bounties de repositorios que no instalaron nada.
//
// Hasta ahora el agente solo pagaba donde corría con su clave: mergit y
// mergit-demo. Cualquiera podía financiar un issue de otro repositorio desde
// /post, pero nadie podía firmar ese pago y lo único que quedaba era el
// reembolso al vencer. Este script cierra esa brecha desde fuera: lee los
// bounties vivos que nombran al agente como verificador, busca el pull request
// mergeado que cierra cada issue y le pasa el caso a `settleBounty`, que verifica
// y paga con las mismas reglas de siempre. Aquí no se copia ninguna regla de pago.
//
//   node watch.mjs                       ensayo: dice qué pagaría
//   node watch.mjs --send                paga (exige MERGIT_AGENT_KEY en el entorno)
//
// ───────────────────────────── Lo que NO hace ──────────────────────────────
//
// - **No toca los repositorios conectados.** Ahí ya paga `on-event.mjs` al
//   mergear, con recibo en el PR. Dos caminos sobre el mismo bounty serían ruido.
// - **No elige.** Dos bounties vivos sobre el mismo issue, o dos PRs mergeados
//   que dicen cerrarlo, y no paga nadie. La misma regla que `bountyForIssue`.
// - **No usa `mergit.json`.** En un repositorio ajeno ese archivo lo controla
//   su mantenedor, no quien cobra. La wallet sale solo del registro on-chain o
//   del README de perfil del autor, que controla el autor.
// - **No le paga a quien financió.** Si la wallet del autor es la del
//   financiador, no hay pago: es la regla de Season 0 y el abuso más obvio
//   cuando cualquiera puede financiar su propio repositorio.
// - **No paga sin tope.** Un monto por bounty (`MERGIT_WATCH_MAX`, 0,01 ETH por
//   defecto) y un número de pagos por corrida. Lo que pase el tope lo mira una persona.
// - **No comenta en el PR.** El token de Actions de este repositorio no puede
//   escribir en repositorios ajenos. El registro queda en el resumen de la
//   corrida y, en la cadena, en el expediente del developer (/p/<login>).
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { formatEther, parseEther } from "viem";
import { listBounties, isLive, closedIssues } from "./bounties.mjs";
import { resolveWallet } from "./registry.mjs";
import { settleBounty } from "./settle.mjs";
import { escrowAddress, fail, args } from "./chain.mjs";

/** El verificador que firma: la dirección del agente de Mergit. */
export const AGENT = "0x28df38871ef4beebd6b0d8cd6d4c99bf4fe3852b";
/** Donde ya corre `on-event.mjs`. El vigilante no entra aquí. */
export const CONNECTED = ["odiseo159-beep/mergit", "odiseo159-beep/mergit-demo"];

const API = "https://api.github.com";

/**
 * El issue al que apunta un bounty, o null. Solo un issue: un repositorio
 * suelto obligaría a adivinar qué pull request lo cobra.
 */
export function issueOf(uri) {
  const m = String(uri || "").trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() };
}

/**
 * De todos los bounties del escrow, los que le tocan al vigilante, y los que se
 * descartan con su motivo. Pura: no lee nada de la red.
 */
export function candidates(bounties, { verifier = AGENT, connected = CONNECTED, maxWei = null, now = Date.now() } = {}) {
  const porIssue = new Map();
  const skipped = [];
  for (const b of bounties) {
    if (!isLive(b, now) || b.verifier !== verifier.toLowerCase()) continue;
    const issue = issueOf(b.uri);
    if (!issue) {
      skipped.push({ ids: [b.id], why: "it does not point at an issue, so there is no way to tell which pull request claims it" });
      continue;
    }
    if (connected.includes(`${issue.owner}/${issue.repo}`.toLowerCase())) continue;
    const g = porIssue.get(issue.key) ?? { issue, bounties: [] };
    g.bounties.push(b);
    porIssue.set(issue.key, g);
  }

  const ready = [];
  for (const { issue, bounties: bs } of porIssue.values()) {
    if (bs.length > 1) {
      skipped.push({ ids: bs.map((b) => b.id), issue: issue.key, why: `${bs.length} live bounties point at the same issue, so there is nothing to choose` });
      continue;
    }
    const b = bs[0];
    if (maxWei !== null && BigInt(b.amount) > maxWei) {
      skipped.push({ ids: [b.id], issue: issue.key, why: `${formatEther(BigInt(b.amount))} ETH is over the ${formatEther(maxWei)} ETH cap for unattended payment` });
      continue;
    }
    ready.push({ bounty: b, issue });
  }
  return { ready, skipped };
}

/** Entre los pull requests que mencionan el issue, los mergeados en ese repositorio que dicen cerrarlo. */
export function closingMerged(prs, issue) {
  const repo = `${issue.owner}/${issue.repo}`.toLowerCase();
  return prs.filter((p) => p?.merged_at
    && String(p.base?.repo?.full_name || "").toLowerCase() === repo
    && closedIssues(p.body).includes(issue.number));
}

// ─────────────────────────────── GitHub ────────────────────────────────

export function ghClient(token) {
  return async function gh(path) {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mergit-watch",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} en ${path}`);
    return res.json();
  };
}

/** Los pull requests del mismo repositorio que mencionan el issue, leídos de su historial. */
export async function prsMentioning(gh, issue) {
  const repo = `${issue.owner}/${issue.repo}`.toLowerCase();
  const nums = new Set();
  for (let page = 1; page <= 5; page++) {
    const ev = await gh(`/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/timeline?per_page=100&page=${page}`);
    if (!ev) return [];
    for (const e of ev) {
      const src = e.event === "cross-referenced" ? e.source?.issue : null;
      if (!src?.pull_request) continue;
      const deDonde = String(src.repository?.full_name || src.repository_url?.split("/repos/")[1] || "").toLowerCase();
      if (deDonde === repo) nums.add(src.number);
    }
    if (ev.length < 100) break;
  }
  const prs = [];
  for (const n of nums) {
    const p = await gh(`/repos/${issue.owner}/${issue.repo}/pulls/${n}`);
    if (p) prs.push(p);
  }
  return prs;
}

// ──────────────────────────────── Corrida ───────────────────────────────

/**
 * Una pasada completa. Devuelve las líneas del informe. Si la cadena no se
 * puede leer, lanza: una lista a medias no se distingue de "no hay nada".
 */
export async function run({ send = false, maxWei = parseEther("0.01"), maxPerRun = 5, token = process.env.GITHUB_TOKEN } = {}) {
  const lines = [];
  const say = (l) => { console.log(l); lines.push(l); };
  const gh = ghClient(token);

  const todos = await listBounties({ address: escrowAddress() });
  const { ready, skipped } = candidates(todos, { maxWei });
  say(`${send ? "Paying" : "Rehearsal, nothing is signed"}. ${ready.length} bounty(ies) in other repositories to check, ${skipped.length} skipped.`);
  for (const s of skipped) say(`skip: bounty #${s.ids.join(", #")}${s.issue ? ` (${s.issue})` : ""}: ${s.why}.`);

  let intentos = 0;
  for (const { bounty: b, issue } of ready) {
    const tag = `bounty #${b.id} (${issue.key}, ${formatEther(BigInt(b.amount))} ETH)`;
    if (intentos >= maxPerRun) { say(`stop: ${maxPerRun} payments per run reached. The rest wait for the next run.`); break; }
    try {
      const repo = await gh(`/repos/${issue.owner}/${issue.repo}`);
      if (!repo || repo.private) { say(`${tag}: the repository is missing or private. Skipped.`); continue; }
      const merged = closingMerged(await prsMentioning(gh, issue), issue);
      if (merged.length === 0) { say(`${tag}: no merged pull request closes it yet.`); continue; }
      if (merged.length > 1) {
        say(`${tag}: ${merged.length} merged pull requests say they close it (#${merged.map((p) => p.number).join(", #")}), so there is nothing to choose. Not paid.`);
        continue;
      }
      const pr = merged[0];
      const author = pr.user?.login;
      const who = await resolveWallet(author, undefined, token);
      if (!who.wallet) { say(`${tag}: PR #${pr.number} by @${author}: ${who.reason}. Not paid.`); continue; }
      if (who.wallet.toLowerCase() === b.funder) {
        say(`${tag}: PR #${pr.number} by @${author} would pay the wallet that funded the bounty. Not paid.`);
        continue;
      }

      intentos++;
      const r = await settleBounty({ bountyId: b.id, target: { owner: issue.owner, repo: issue.repo, number: pr.number }, developer: who.wallet, send });
      const v = r.verdict;
      const via = who.source === "registry" ? "on-chain registry" : "profile README";
      if (r.stage === "dry-run") say(`${tag}: PR #${pr.number} by @${author} verified. Would pay ${formatEther(r.payout)} ETH to ${who.wallet} (${via}).`);
      else if (r.stage === "paid") say(`${tag}: PAID ${formatEther(r.event?.paidToDeveloper ?? r.payout)} ETH to ${who.wallet} for PR #${pr.number}. ${r.url}`);
      else if (r.stage === "proposed") say(`${tag}: settlement proposed for ${who.wallet}; the funder can object until the window closes. ${r.url}`);
      else if (r.stage === "pending") say(`${tag}: payment pending, claimable at ${new Date(r.claimableAt * 1000).toISOString()}.`);
      else if (r.stage === "verify" && v && !v.merged) say(`${tag}: PR #${pr.number} is not merged. Waiting.`);
      else if (r.stage === "verify" && v?.ciPending) say(`${tag}: CI still running on PR #${pr.number}. Waiting.`);
      else say(`${tag}: PR #${pr.number} not paid: ${r.reason}.`);
    } catch (e) {
      // Un repositorio que falla no tumba la corrida: los demás siguen.
      say(`${tag}: could not check it (${e.message}). Nothing was decided.`);
    }
  }
  return lines;
}

// ──────────────────────────────── CLI ──────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = args();
  const send = arg.has("send");
  // Para firmar, la clave tiene que venir del entorno y a propósito. settle.mjs
  // también sabe leerla de WALLETS.secret.json, y un ensayo en la laptop no
  // debe convertirse en pago por olvidar un flag.
  if (send && !process.env.MERGIT_AGENT_KEY) fail("--send exige MERGIT_AGENT_KEY en el entorno");
  const maxWei = parseEther(process.env.MERGIT_WATCH_MAX || "0.01");

  let lines;
  try {
    lines = await run({ send, maxWei });
  } catch (e) {
    lines = [`could not read the bounties from the explorer (${e.message}). Nothing was decided and nothing was paid.`];
    console.error(lines[0]);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mergit watch\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  }
}
