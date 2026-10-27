// Le dice a quien abre un pull request qué le falta para poder cobrar, antes de
// que trabaje gratis. Seis de las ocho primeras personas que mandaron trabajo no
// podían cobrar, y ninguna lo supo hasta después.
//
// Comprueba dos cosas y nada más:
//   1. que el cuerpo lleve una línea `Bounty: #N` de un bounty vivo que nombre a
//      nuestro agente como verificador
//   2. que el autor tenga una wallet que el agente pueda resolver
//
// **No tiene ninguna clave y no toca fondos.** Lee la cadena por el explorador y
// el README por raw.githubusercontent.com, así que no instala dependencias ni
// gasta la cuota de la API de GitHub.
//
// Deja **un solo comentario** y lo reescribe en cada cambio. Un hilo con ocho
// comentarios del mismo bot es ruido, y la gente deja de leerlo.

const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY = "0x79d44543d20c7c6653f6626687d67d2cd7f2af9c";
const ESCROWS = [
  { v: "v1", address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879" },
  { v: "v2", address: "0x48d506080abdbed11f1acbe40f799301d9612ad5" },
];
const MARCA = "<!-- mergit-preflight -->";

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  PR_NUMBER, PR_AUTHOR, PR_BODY = "",
  MERGIT_VERIFIER = "", DRY_RUN = "",
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

/** El estado de cada bounty, calculado de los eventos. Sin ABI y sin firmar. */
async function bounties() {
  const out = new Map();
  for (const { v, address } of ESCROWS) {
    let ev;
    try { ev = await logsOf(address); } catch { continue; }
    for (const e of ev) {
      if (e.kind !== "BountyPosted") continue;
      out.set(String(e.bountyId), {
        id: String(e.bountyId), v,
        verifier: String(e.verifier || "").toLowerCase(),
        deadline: Number(e.deadline || 0),
        cerrado: false,
      });
    }
    for (const e of ev) {
      if (e.kind !== "BountySettled" && e.kind !== "BountyRefunded") continue;
      const b = out.get(String(e.bountyId));
      if (b && b.v === v) b.cerrado = true;
    }
  }
  return out;
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
  const todos = await bounties();
  const vivos = [...todos.values()].filter((b) =>
    !b.cerrado && b.deadline * 1000 > Date.now()
    && (!MERGIT_VERIFIER || b.verifier === MERGIT_VERIFIER.toLowerCase()));

  const m = PR_BODY.match(/^[ \t]*bounty:[ \t]*#?(\d+)[ \t]*$/im);
  const filas = [];
  let listo = true;

  if (!m) {
    listo = false;
    filas.push(no("**No `Bounty: #N` line in the description.** Put it on a line of its own. Without it the agent does not know which bounty this claims, and treats the pull request as an ordinary one."));
  } else {
    const id = m[1];
    const b = todos.get(id);
    if (!b) {
      listo = false;
      filas.push(no("**Bounty #" + id + " does not exist.** The number is the bounty's, not the issue's. They are different numbers, and this is the mistake almost everybody makes."));
    } else if (b.cerrado) {
      listo = false;
      filas.push(no("**Bounty #" + id + " is already closed.** It was settled or refunded, so there is nothing left in it."));
    } else if (b.deadline * 1000 <= Date.now()) {
      listo = false;
      filas.push(no("**Bounty #" + id + " expired** on " + new Date(b.deadline * 1000).toISOString().slice(0, 16) + "Z. The contract refuses to settle after the deadline."));
    } else if (MERGIT_VERIFIER && b.verifier !== MERGIT_VERIFIER.toLowerCase()) {
      listo = false;
      filas.push(no("**Bounty #" + id + " names a different verifier**, so this repository's agent cannot settle it."));
    } else {
      const dias = ((b.deadline * 1000 - Date.now()) / 86400000).toFixed(1);
      filas.push(si("**Bounty #" + id + "** is open on escrow " + b.v + ", and closes in " + dias + " days."));
    }
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

  const abiertos = vivos.length && !m
    ? "\nOpen right now: " + vivos.map((b) => "`Bounty: #" + b.id + "`").join(", ") + ".\n"
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
