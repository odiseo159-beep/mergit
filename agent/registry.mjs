// El registro on-chain: quién es quién entre GitHub y la cadena.
//
// El contrato guarda la afirmación ("esta wallet es este login, y aquí está la
// prueba"), pero no puede comprobarla: no habla con GitHub. Eso lo hace este
// módulo, y lo hace igual que lo haría cualquiera que quisiera desmentirla:
// pide la publicación a la API de GitHub, comprueba que pertenece al login y
// que contiene la dirección reclamada.
//
// Formas de prueba aceptadas hoy:
//   - un gist del usuario            https://gist.github.com/<login>/<id>
//   - el README del repo de perfil   https://github.com/<login>/<login>
//
// Si no hay registro configurado, el agente sigue con `mergit.json`. Esa es la
// transición: el archivo del repositorio deja de ser la fuente de verdad en
// cuanto el desarrollador reclama su login.
import { readFileSync, existsSync } from "node:fs";
import { getAddress } from "viem";
import { publicClient } from "./chain.mjs";

const API = "https://api.github.com";

export const REGISTRY_ABI = [
  {
    type: "function",
    name: "claimOf",
    stateMutability: "view",
    inputs: [{ name: "login", type: "string" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "wallet", type: "address" },
          { name: "claimedAt", type: "uint64" },
          { name: "login", type: "string" },
          { name: "proofURI", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "login", type: "string" },
      { name: "proofURI", type: "string" },
    ],
    outputs: [{ name: "loginHash", type: "bytes32" }],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "loginOf",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "totalClaims",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];

/** Dirección del registro: variable de entorno, o el despliegue guardado. */
export function registryAddress() {
  if (process.env.MERGIT_REGISTRY) return getAddress(process.env.MERGIT_REGISTRY);
  const file = new URL("../contracts/registry.json", import.meta.url);
  if (!existsSync(file)) return null;
  const { address } = JSON.parse(readFileSync(file, "utf8"));
  return address ? getAddress(address) : null;
}

/** La reclamación de un login, o null si no hay registro o nadie lo reclamó. */
export async function claimFor(login) {
  const address = registryAddress();
  if (!address) return null;

  const claim = await publicClient.readContract({
    address,
    abi: REGISTRY_ABI,
    functionName: "claimOf",
    args: [login],
  });
  if (claim.wallet === "0x0000000000000000000000000000000000000000") return null;
  return { wallet: claim.wallet, claimedAt: Number(claim.claimedAt), login: claim.login, proofURI: claim.proofURI };
}

/** Pide algo a GitHub. Devuelve null en 404, para poder distinguir "no existe". */
async function gh(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mergit-agent",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`GitHub respondió ${res.status} en ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Lee un gist público. El `GITHUB_TOKEN` de Actions no tiene acceso a la API de
 * gists y responde 403, aunque el gist sea público: con ese token, nadie que
 * hubiera probado su login con un gist podía cobrar. Ante un 403 se repite sin
 * token. Si tampoco responde, el error sube y la corrida queda en rojo, sin decirle
 * a nadie que su prueba es mala.
 */
async function ghGist(id, token) {
  try {
    return await gh(`/gists/${id}`, token);
  } catch (e) {
    if (!token || e.status !== 403) throw e;
    return gh(`/gists/${id}`);
  }
}

/**
 * ¿La prueba sostiene la reclamación?
 * Devuelve { ok, reason, where } sin lanzar: una prueba mala no es un error del
 * agente, es un motivo para no pagar.
 */
export async function checkProof({ login, wallet, proofURI }, token = process.env.GITHUB_TOKEN) {
  const want = wallet.toLowerCase();
  const owns = (owner) => owner?.toLowerCase() === login.toLowerCase();

  const gist = proofURI.match(/^https:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)/i);
  if (gist) {
    const [, urlLogin, id] = gist;
    if (!owns(urlLogin)) return { ok: false, reason: `the gist URL is not under @${login}` };

    const data = await ghGist(id, token);
    if (!data) return { ok: false, reason: "the gist does not exist" };
    if (!owns(data.owner?.login)) return { ok: false, reason: `the gist belongs to @${data.owner?.login}` };

    const body = Object.values(data.files ?? {}).map((f) => f.content ?? "").join("\n");
    if (!body.toLowerCase().includes(want)) return { ok: false, reason: "the gist does not contain the claimed address" };
    return { ok: true, where: `gist ${id}` };
  }

  const profile = proofURI.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (profile) {
    const [, urlLogin, repo] = profile;
    if (!owns(urlLogin)) return { ok: false, reason: `the repository is not under @${login}` };

    const readme = await gh(`/repos/${urlLogin}/${repo}/readme`, token);
    if (!readme) return { ok: false, reason: "the repository has no README to read" };

    const body = Buffer.from(readme.content ?? "", "base64").toString("utf8");
    if (!body.toLowerCase().includes(want)) return { ok: false, reason: "the README does not contain the claimed address" };
    return { ok: true, where: `${urlLogin}/${repo} README` };
  }

  return { ok: false, reason: "the proof must be a gist or a GitHub repository README" };
}

/**
 * El README del perfil: `github.com/<login>/<login>`, que es el repo especial
 * que GitHub muestra en la página de cada persona.
 *
 * Es el camino sin peaje. Para cobrar no hace falta wallet conectada, ni ETH de
 * faucet, ni firmar nada: una línea en un archivo que ese dev ya edita. Lo que
 * asegura el vínculo es lo mismo de siempre, que solo esa cuenta puede publicar
 * ahí; la firma nunca fue lo que lo aseguraba.
 *
 * La línea tiene que nombrar a Mergit y llevar una dirección, para que una
 * dirección de donaciones suelta en un README no se confunda con una intención
 * de cobrar. Si hay varias direcciones distintas, no se adivina: no se paga.
 */
export async function walletFromProfile(login, token = process.env.GITHUB_TOKEN) {
  const readme = await gh(`/repos/${login}/${login}/readme`, token);
  if (!readme) return { ok: false, reason: `@${login} has no profile README` };

  const body = Buffer.from(readme.content ?? "", "base64").toString("utf8");
  const found = [];
  for (const line of body.split(/[\r\n]+/)) {
    if (!/mergit/i.test(line)) continue;
    const m = line.match(/0x[a-fA-F0-9]{40}/);
    if (m) found.push(m[0].toLowerCase());
  }
  const unique = [...new Set(found)];
  if (unique.length === 0) {
    return { ok: false, reason: `@${login}'s profile README has no line naming Mergit with an address` };
  }
  if (unique.length > 1) {
    return { ok: false, reason: `@${login}'s profile README names ${unique.length} different addresses, so there is nothing to choose` };
  }
  return { ok: true, wallet: unique[0], where: `${login}/${login} README` };
}

/**
 * A quién pagar por un pull request de `login`.
 *   { source: "registry" | "profile" | "file" | "none", wallet, reason?, proof? }
 *
 * Tres fuentes, en este orden y por esta razón:
 *   1. el registro on-chain, que el dev firmó
 *   2. su README de perfil, que solo él puede editar
 *   3. mergit.json, que edita el dueño del repositorio
 * Las dos primeras las controla quien cobra; la tercera no. Por eso va última:
 * si mandara el archivo, el dueño de un repo podría desviar el pago de quien
 * hizo el trabajo.
 *
 * Si el registro existe y su prueba falla, no se cae a las siguientes: una
 * reclamación rota tiene que doler, no pasar de largo.
 */
export async function resolveWallet(login, fileWallet, token) {
  const claim = await claimFor(login);
  if (claim) {
    const proof = await checkProof(claim, token);
    if (!proof.ok) {
      return { source: "none", reason: `@${login} registered ${claim.wallet} on-chain, but ${proof.reason}`, claim };
    }
    return { source: "registry", wallet: claim.wallet, proof: proof.where, claim };
  }

  const profile = await walletFromProfile(login, token);
  if (profile.ok) {
    return { source: "profile", wallet: profile.wallet, proof: profile.where };
  }

  if (fileWallet) return { source: "file", wallet: fileWallet };

  return { source: "none", reason: `@${login} is not in the registry, ${profile.reason}, and mergit.json has no wallet for them` };
}
