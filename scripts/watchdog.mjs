// Avisa de lo que está a punto de costar dinero, antes de que cueste.
//
// El 25 de octubre los bounties #9 y #10 vencieron con cuatro pull requests
// listos para cobrar. No falló el producto: falló que nadie miró el calendario.
// El contrato no deja liquidar pasado el plazo, así que ocho personas
// trabajaron gratis por una fecha.
//
// Mira dos cosas cada día:
//   1. bounties abiertos a menos de N horas de vencer **con pull requests que
//      los nombran y siguen sin mergear**. Un bounty que vence sin candidatos no
//      es urgente: es un bounty que nadie tomó.
//   2. corridas atascadas en `action_required`, que es el botón de aprobar el
//      workflow de un primerizo sin pulsar. Sin CI no hay pago.
//
// **No tiene ninguna clave y no toca fondos.** Comenta en un issue fijo, que es
// lo que llega al correo. Edita el cuerpo siempre, y **solo comenta cuando hay
// algo urgente**, para que el aviso signifique algo.

const EXPLORER = "https://sepolia-explorer.giwa.io";
const ESCROWS = [
  { v: "v1", address: "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879" },
  { v: "v2", address: "0x48d506080abdbed11f1acbe40f799301d9612ad5" },
];
const MARCA = "<!-- mergit-watchdog -->";

const {
  GITHUB_TOKEN, GITHUB_REPOSITORY,
  AVISAR_A = "odiseo159-beep",
  HORAS = "72",
  MERGIT_VERIFIER = "",
  DRY_RUN = "",
} = process.env;

const seco = DRY_RUN === "1";
const umbral = Number(HORAS) * 3600 * 1000;
const [owner, repo] = String(GITHUB_REPOSITORY).split("/");

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

async function bountiesVivos() {
  const todos = new Map();
  for (const { v, address } of ESCROWS) {
    let ev;
    try { ev = await logsOf(address); } catch { continue; }
    for (const e of ev) {
      if (e.kind !== "BountyPosted") continue;
      todos.set(v + "#" + e.bountyId, {
        id: String(e.bountyId), v,
        verifier: String(e.verifier || "").toLowerCase(),
        deadline: Number(e.deadline || 0),
        uri: e.metadataURI || "",
        cerrado: false,
      });
    }
    for (const e of ev) {
      if (e.kind !== "BountySettled" && e.kind !== "BountyRefunded") continue;
      const b = todos.get(v + "#" + e.bountyId);
      if (b) b.cerrado = true;
    }
  }
  return [...todos.values()].filter((b) =>
    !b.cerrado && b.deadline * 1000 > Date.now()
    && (!MERGIT_VERIFIER || b.verifier === MERGIT_VERIFIER.toLowerCase()));
}

const reBounty = (id) => new RegExp("^[ \\t]*bounty:[ \\t]*#?" + id + "[ \\t]*$", "im");

async function main() {
  const vivos = await bountiesVivos();
  const abiertos = await gh("/repos/" + owner + "/" + repo + "/pulls?state=open&per_page=100");

  const urgentes = [];
  for (const b of vivos) {
    const falta = b.deadline * 1000 - Date.now();
    const candidatos = (abiertos || []).filter((p) => reBounty(b.id).test(String(p.body || "")));
    if (falta <= umbral && candidatos.length) urgentes.push({ b, candidatos, falta });
  }

  let atascadas = [];
  try {
    const runs = await gh("/repos/" + owner + "/" + repo + "/actions/runs?status=action_required&per_page=50");
    atascadas = (runs && runs.workflow_runs) || [];
  } catch { /* sin permiso de actions, se informa igual del resto */ }

  const horas = (ms) => (ms / 3600000).toFixed(1);
  const lineas = [];

  if (urgentes.length) {
    lineas.push("### Bounties about to expire with work waiting", "");
    for (const u of urgentes) {
      lineas.push("- **Bounty #" + u.b.id + "** (escrow " + u.b.v + ") closes in **" + horas(u.falta) + " h**, and "
        + u.candidatos.length + " open pull request" + (u.candidatos.length === 1 ? "" : "s") + " claim" + (u.candidatos.length === 1 ? "s" : "") + " it: "
        + u.candidatos.map((p) => "#" + p.number).join(", ")
        + ". After the deadline the contract refuses to settle, and the only way out is a refund.");
    }
    lineas.push("");
  }

  if (atascadas.length) {
    lineas.push("### Workflow runs waiting for approval", "");
    for (const r of atascadas.slice(0, 10)) {
      lineas.push("- [" + r.name + " on " + (r.head_branch || "?") + "](" + r.html_url + ") has been waiting since "
        + String(r.created_at).slice(0, 16).replace("T", " ") + " UTC. Until it runs there is no CI, and without CI the agent pays nobody.");
    }
    lineas.push("");
  }

  const estado = vivos.length
    ? vivos.map((b) => "- Bounty **#" + b.id + "** (" + b.v + "), " + horas(b.deadline * 1000 - Date.now()) + " h left"
        + ((abiertos || []).filter((p) => reBounty(b.id).test(String(p.body || ""))).length
          ? ", claimed by " + (abiertos || []).filter((p) => reBounty(b.id).test(String(p.body || ""))).map((p) => "#" + p.number).join(", ")
          : ", nobody has claimed it yet")).join("\n")
    : "- No bounty is open right now.";

  const cuerpo = [
    MARCA,
    "Checked automatically once a day. Nothing here is written by hand, and this issue holds no key.",
    "",
    "## Open bounties",
    "",
    estado,
    "",
    "_Last checked " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC._",
  ].join("\n");

  const alerta = lineas.length
    ? ["@" + AVISAR_A + " something here needs a hand today.", "", ...lineas,
       "_Posted by the watchdog. It only comments when something is about to cost money._"].join("\n")
    : null;

  if (seco) {
    console.log("—— cuerpo del issue ——\n" + cuerpo);
    console.log("\n—— alerta ——\n" + (alerta || "(nada urgente, no comentaría)"));
    return;
  }

  // Un issue fijo. Editar el cuerpo no notifica a nadie, así que el aviso va en
  // un comentario, y solo cuando hay algo urgente.
  const encontrados = await gh("/repos/" + owner + "/" + repo + "/issues?state=all&per_page=100&labels=watchdog");
  let issue = (encontrados || []).find((i) => String(i.body || "").includes(MARCA));

  if (!issue) {
    issue = await gh("/repos/" + owner + "/" + repo + "/issues", {
      method: "POST",
      body: JSON.stringify({ title: "Mergit watchdog", body: cuerpo, labels: ["watchdog"] }),
    });
    console.log("issue creado: #" + issue.number);
  } else {
    await gh("/repos/" + owner + "/" + repo + "/issues/" + issue.number, {
      method: "PATCH", body: JSON.stringify({ body: cuerpo, state: "open" }),
    });
    console.log("issue #" + issue.number + " actualizado");
  }

  if (alerta) {
    await gh("/repos/" + owner + "/" + repo + "/issues/" + issue.number + "/comments", {
      method: "POST", body: JSON.stringify({ body: alerta }),
    });
    console.log("aviso publicado");
  } else {
    console.log("nada urgente, sin aviso");
  }
}

main().catch((e) => { console.error("watchdog:", e.message); process.exit(1); });
