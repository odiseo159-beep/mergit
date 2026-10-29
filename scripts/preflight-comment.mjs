// Le dice a quien abre un pull request qué le falta para poder cobrar, antes de
// que trabaje gratis. Seis de las ocho primeras personas que mandaron trabajo no
// podían cobrar, y ninguna lo supo hasta después.
//
// Comprueba dos cosas y nada más:
//   1. que el pull request apunte a un bounty vivo que nombre a nuestro agente
//      como verificador, por la línea `Bounty: #N` **o** por el issue que cierra
//   2. que el autor tenga una wallet que el agente pueda resolver
//
// **No tiene ninguna clave y no toca fondos.** Lee la cadena por el explorador y
// el README por raw.githubusercontent.com, así que no instala dependencias ni
// gasta la cuota de la API de GitHub.
//
// Deja **un solo comentario** y lo reescribe en cada cambio. Un hilo con ocho
// comentarios del mismo bot es ruido, y la gente deja de leerlo.
//
// ⚠️ Lo que decide aquí tiene que ser lo mismo que decide el agente al pagar, y
// por eso **importa `agent/bounties.mjs` en lugar de repetir la lógica**. Cuando
// se repuso un bounty, su número cambió y esta comprobación habría dicho "no se
// puede pagar" a seis pull requests que el agente sí paga. Un preflight que
// contradice al pagador es peor que no tener preflight.
import { listBounties, isLive, closedIssues, bountyForIssue } from "../agent/bounties.mjs";

const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
const MARCA = "<!-- mergit-preflight -->";

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  PR_NUMBER, PR_AUTHOR, PR_BODY = "",
  MERGIT_VERIFIER = "", DRY_RUN = "",
  // El escrow donde este repositorio liquida. Los números de bounty se repiten
  // entre despliegues, así que mirar más de uno es mirar bounties que el agente
  // no va a pagar.
  MERGIT_ESCROW = "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879",
} = process.env;

const seco = DRY_RUN === "1";

async function gh(path, init) {
  const r = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      ...(GITHUB_TOKEN ? { Authorization: "Bearer " + GITHUB_TOKEN } : {}),
      ...((init && init.headers) || {}),
    },
  });
  if (!r.ok) throw new Error("GitHub " + r.status + " en " + path);
  return r.status === 204 ? null : r.json();
}

async function logsOf(address) {
  const r = await fetch(EXPLORER + "/api/v2/addresses/" + address + "/logs");
  if (!r.ok) throw new Error("explorador " + r.status);
  const d = await r.json();
  return (d.items || []).filter((it) => it.decoded).map((it) => {
    const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
    return { kind: it.decoded.method_call.split("(")[0], ...p };
  });
}

/** La wallet del autor, en el mismo orden que usa el agente antes de pagar. */
async function walletDe(login) {
  try {
    const ev = await logsOf(REGISTRY);
    let claim = null;
    for (const e of ev) {
      if (e.kind === "Claimed" && String(e.login || "").toLowerCase() === login.toLowerCase()) claim = e;
    }
    if (claim) return { wallet: String(claim.wallet).toLowerCase(), source: "the on-chain registry" };
  } catch { /* el registro no manda: queda el README */ }

  try {
    const r = await fetch("https://raw.githubusercontent.com/" + login + "/" + login + "/HEAD/README.md");
    if (r.ok) {
      const body = await r.text();
      const found = new Set();
      for (const line of body.split(/[\r\n]+/)) {
        if (!/mergit/i.test(line)) continue;
        const m = line.match(/0x[a-fA-F0-9]{40}/);
        if (m) found.add(m[0].toLowerCase());
      }
      const u = [...found];
      if (u.length === 1) return { wallet: u[0], source: "the README of " + login + "/" + login };
      if (u.length > 1) return { wallet: null, varias: u.length };
    }
  } catch { /* sin README */ }
  return { wallet: null };
}

const si = (t) => "- ✅ " + t;
const no = (t) => "- ❌ " + t;

async function main() {
  const [owner, repo] = String(GITHUB_REPOSITORY).split("/");

  // Solo el escrow donde liquida este repositorio. Ver MERGIT_ESCROW arriba.
  const aqui = MERGIT_ESCROW.toLowerCase();
  const mios = (await listBounties()).filter((b) => b.address.toLowerCase() === aqui);
  const porId = new Map(mios.map((b) => [b.id, b]));
  const nuestro = (b) => !MERGIT_VERIFIER || b.verifier === MERGIT_VERIFIER.toLowerCase();
  const vivos = mios.filter((b) => isLive(b) && nuestro(b));

  const m = PR_BODY.match(/^[ \t]*bounty:[ \t]*#?(\d+)[ \t]*$/im);
  const cierra = closedIssues(PR_BODY);
  const filas = [];
  let listo = true;

  // El mismo orden que el agente: la línea explícita si sigue sirviendo, y si no,
  // el issue que el pull request cierra.
  let elegido = null;
  let via = "";
  if (m && porId.has(m[1])) {
    const b = porId.get(m[1]);
    if (isLive(b) && nuestro(b)) { elegido = b; via = "line"; }
  }

  let ambiguo = null;
  if (!elegido) {
    for (const n of cierra) {
      const r = bountyForIssue({ bounties: mios, owner, repo, issue: n, verifier: MERGIT_VERIFIER || undefined });
      if (r.bounty) { elegido = r.bounty; via = "issue #" + n; break; }
      if (r.ambiguous) { ambiguo = r.reason; break; }
    }
  }

  const dias = (b) => ((b.deadline * 1000 - Date.now()) / 86400000).toFixed(1);

  if (elegido && via === "line") {
    filas.push(si("**Bounty #" + elegido.id + "** is open on escrow " + elegido.escrow + ", and closes in " + dias(elegido) + " days."));
  } else if (elegido) {
    filas.push(si("This pull request closes " + via + ", and **bounty #" + elegido.id
      + "** funds it — open on escrow " + elegido.escrow + ", closing in " + dias(elegido) + " days. "
      + "The agent resolves it from the issue, so you do not need to touch the `Bounty: #N` line"
      + (m ? ", even though yours names #" + m[1] + ", which is no longer open" : "") + "."));
  } else if (ambiguo) {
    listo = false;
    filas.push(no("**More than one open bounty points at the issue this closes**, so the agent refuses to choose. " + ambiguo));
  } else {
    listo = false;
    const comoApuntar = cierra.length
      ? "This pull request closes #" + cierra.join(", #") + ", but no open bounty points at "
        + (cierra.length === 1 ? "it" : "any of them") + "."
      : "The description has no `Closes #N` line either, so there is no issue to go by.";
    const linea = m
      ? "**Bounty #" + m[1] + " is not open"
        + (porId.has(m[1]) ? " any more: it was settled, refunded, or its deadline passed" : ", and may never have existed on this escrow")
        + ".** "
      : "**This pull request does not point at any bounty.** ";
    filas.push(no(linea + comoApuntar + " The surest way is a line saying `Closes #N` with the issue number: that one never changes, even when a bounty is refunded and funded again under a new number."));
  }

  const w = await walletDe(PR_AUTHOR);
  if (w.wallet) {
    filas.push(si("The agent can pay **@" + PR_AUTHOR + "** at `" + w.wallet + "`, read from " + w.source + "."));
  } else if (w.varias) {
    listo = false;
    filas.push(no("Your profile README names **" + w.varias + " different addresses** next to Mergit. The agent does not guess, so it pays none of them. Leave one."));
  } else {
    listo = false;
    filas.push(no("**The escrow has no address for @" + PR_AUTHOR + ".** A GitHub login is not an address. Put one line naming Mergit and your address in the README of `" + PR_AUTHOR + "/" + PR_AUTHOR + "`, the repository that has your own name. Nothing to connect, no gas, nothing to sign."));
  }

  // Qué hay abierto, solo cuando el pull request no encontró nada. Con el bounty
  // ya resuelto, enumerar los demás es ruido.
  const abiertos = vivos.length && !elegido
    ? "\nOpen right now: " + vivos.map((b) => "**bounty #" + b.id + "** for " + (b.uri || "(no reference)")).join(" · ") + ".\n"
    : "";

  const cuerpo = [
    MARCA,
    listo
      ? "### Ready to be paid\n\nMerge this with CI green and the agent settles the bounty on its own, then leaves the receipt here. Nobody approves the payment."
      : "### Not payable yet\n\nA machine checked the two things that decide whether you can be paid. This is not a review of your code.",
    "",
    filas.join("\n"),
    abiertos,
    "---",
    "",
    "On a first pull request the CI waits for a maintainer to approve the workflow run, so a missing check here is not something you did wrong.",
    "",
    "Read from GIWA Sepolia just now. The full record lives at https://www.mergit.xyz/p/" + PR_AUTHOR,
  ].join("\n");

  if (seco) { console.log(cuerpo); return; }

  const previos = await gh("/repos/" + owner + "/" + repo + "/issues/" + PR_NUMBER + "/comments?per_page=100");
  const mio = (previos || []).find((c) => String(c.body || "").includes(MARCA));
  if (mio) {
    await gh("/repos/" + owner + "/" + repo + "/issues/comments/" + mio.id, {
      method: "PATCH", body: JSON.stringify({ body: cuerpo }),
    });
    console.log("comentario " + mio.id + " actualizado");
  } else {
    await gh("/repos/" + owner + "/" + repo + "/issues/" + PR_NUMBER + "/comments", {
      method: "POST", body: JSON.stringify({ body: cuerpo }),
    });
    console.log("comentario creado");
  }
}

main().catch((e) => { console.error("preflight:", e.message); process.exit(1); });
