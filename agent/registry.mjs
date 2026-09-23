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
  if (!res.ok) throw new Error(`GitHub respondió ${res.status} en ${path}`);
  return res.json();
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

    const data = await gh(`/gists/${id}`, token);
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
 * A quién pagar por un pull request de `login`.
 *   { source: "registry" | "file" | "none", wallet, reason?, proof? }
 * El registro manda cuando existe y su prueba se sostiene. Si la prueba falla,
 * no se cae al archivo: una reclamación rota tiene que doler, no pasar de largo.
 */
export async function resolveWallet(login, fileWallet, token) {
  const claim = await claimFor(login);
  if (!claim) {
    return fileWallet
      ? { source: "file", wallet: fileWallet }
      : { source: "none", reason: `@${login} has no wallet in the registry or in mergit.json` };
  }

  const proof = await checkProof(claim, token);
  if (!proof.ok) {
    return { source: "none", reason: `@${login} claimed ${claim.wallet} on-chain, but ${proof.reason}`, claim };
  }
  return { source: "registry", wallet: claim.wallet, proof: proof.where, claim };
}
