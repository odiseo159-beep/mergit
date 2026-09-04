// Agente de verificación de Mergit — paso 2: pagar lo que el paso 1 aprobó.
//
// Verifica el pull request, comprueba que el bounty siga abierto y que este
// agente sea su verificador, y libera el escrow al desarrollador dejando el
// hash de la evidencia grabado en el evento BountySettled.
//
//   node settle.mjs --bounty 2 --pr https://github.com/owner/repo/pull/7
//   node settle.mjs --bounty 2 --pr owner/repo#7 --developer 0xabc... --send
//
// Sin --send no se firma nada: simula la transacción contra la cadena y
// reporta qué pasaría. Es el modo por defecto a propósito.
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { verifyPullRequest } from "./verify.mjs";

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
};
const EXPLORER = giwaSepolia.blockExplorers.default.url;

// ABI mínimo: solo lo que el agente necesita. Así este directorio no depende
// de que alguien haya compilado los contratos antes.
const ABI = [
  {
    type: "function",
    name: "getBounty",
    stateMutability: "view",
    inputs: [{ name: "bountyId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "funder", type: "address" },
          { name: "verifier", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint64" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [
      { name: "payout", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bountyId", type: "uint256" },
      { name: "developer", type: "address" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "BountySettled",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "developer", type: "address", indexed: true },
      { name: "verifier", type: "address", indexed: true },
      { name: "paidToDeveloper", type: "uint256", indexed: false },
      { name: "protocolFee", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
    ],
  },
];

const STATUS = ["None", "Open", "Settled", "Refunded"];

// ───────────────────────────── Argumentos ──────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

const bountyId = flag("bounty");
const prTarget = flag("pr");
const send = argv.includes("--send");

if (!bountyId || !prTarget) {
  console.error("uso: node settle.mjs --bounty <id> --pr <url|owner/repo#n> [--developer 0x...] [--send]");
  process.exit(2);
}

const fail = (msg) => {
  console.error(`\nabortado: ${msg}`);
  process.exit(1);
};

function parseTarget(raw) {
  const url = raw.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const short = raw.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  return fail(`no entiendo el pull request: ${raw}`);
}

// ─────────────────────────── Configuración ─────────────────────────

const SECRETS = new URL("../WALLETS.secret.json", import.meta.url);
const secrets = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, "utf8")) : null;

const deploymentPath = new URL("../contracts/deployment.json", import.meta.url);
const escrowAddress =
  process.env.MERGIT_ESCROW ??
  (existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")).address : null);
if (!escrowAddress) fail("no sé dónde está el escrow. Define MERGIT_ESCROW o deja contracts/deployment.json en su sitio.");

const developer = flag("developer") ?? secrets?.developer?.address;
if (!developer) fail("falta la dirección del desarrollador: pásala con --developer 0x...");

const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
const contract = { address: escrowAddress, abi: ABI };

// ───────────────────────── 1. ¿Existe el trabajo? ──────────────────

console.log("1. verificando el pull request\n");
const result = await verifyPullRequest(parseTarget(prTarget));
console.log(`   ${result.evidence.repository}#${result.evidence.pullRequest} por ${result.evidence.author}`);
console.log(`   mergeado: ${result.merged ? "sí" : "no"} · CI: ${result.ciReason}`);
console.log(`   evidencia: ${result.evidenceHash}`);

if (!result.verdict) fail(`el trabajo no pasa la verificación (${result.reasons.join("; ")})`);
console.log("   veredicto: PAGAR\n");

// ──────────────────── 2. ¿El bounty admite el pago? ────────────────

console.log("2. revisando el bounty on-chain\n");
let bounty;
try {
  bounty = await publicClient.readContract({ ...contract, functionName: "getBounty", args: [BigInt(bountyId)] });
} catch {
  fail(`el bounty ${bountyId} no existe en ${escrowAddress}`);
}

const [payout, fee] = await publicClient.readContract({
  ...contract,
  functionName: "quote",
  args: [bounty.amount],
});

console.log(`   escrow     : ${escrowAddress}`);
console.log(`   bounty     : #${bountyId} · ${STATUS[bounty.status]} · ${formatEther(bounty.amount)} ETH`);
console.log(`   verificador: ${bounty.verifier}`);
console.log(`   reparto    : ${formatEther(payout)} ETH al desarrollador, ${formatEther(fee)} ETH de comisión`);
console.log(`   destino    : ${developer}\n`);

if (STATUS[bounty.status] !== "Open") fail(`el bounty está ${STATUS[bounty.status]}, no Open`);
if (BigInt(bounty.deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
  fail("el plazo del bounty ya venció; ahora solo cabe el reembolso al financiador");
}

// ─────────────────── 3. Simular, y solo después firmar ─────────────

const agentKey = secrets?.deployer?.privateKey;
if (!agentKey) fail("no encuentro la clave del agente en WALLETS.secret.json");
const agent = privateKeyToAccount(agentKey);

if (agent.address.toLowerCase() !== bounty.verifier.toLowerCase()) {
  fail(`este agente (${agent.address}) no es el verificador del bounty (${bounty.verifier})`);
}

console.log("3. simulando la liquidación\n");
const { request } = await publicClient.simulateContract({
  ...contract,
  functionName: "settle",
  args: [BigInt(bountyId), developer, result.evidenceHash],
  account: agent,
});
console.log("   la cadena acepta la transacción\n");

if (!send) {
  console.log("ensayo, no se firmó nada. Repite con --send para liquidar de verdad.");
  process.exit(0);
}

// ─────────────────────────── 4. Liquidar ───────────────────────────

const balance = await publicClient.getBalance({ address: agent.address });
console.log(`4. liquidando desde ${agent.address} (saldo ${formatEther(balance)} ETH)\n`);

const wallet = createWalletClient({ account: agent, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract(request);
console.log(`   tx enviada: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`   confirmada en el bloque ${receipt.blockNumber} (gas ${receipt.gasUsed})\n`);

for (const log of receipt.logs) {
  try {
    const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
    if (event.eventName !== "BountySettled") continue;
    console.log(`   pagado al desarrollador: ${formatEther(event.args.paidToDeveloper)} ETH`);
    console.log(`   comisión de protocolo  : ${formatEther(event.args.protocolFee)} ETH`);
    console.log(`   evidencia on-chain     : ${event.args.evidenceHash}`);
    console.log(`   coincide con el paso 1 : ${event.args.evidenceHash === result.evidenceHash ? "sí" : "NO"}`);
  } catch {
    // Un log de otro contrato en el mismo recibo: no es asunto nuestro.
  }
}

console.log(`\n${EXPLORER}/tx/${hash}`);
