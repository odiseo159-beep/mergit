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
import { createWalletClient, http, formatEther, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  giwaSepolia,
  EXPLORER,
  ABI,
  STATUS,
  publicClient,
  fail,
  loadSecrets,
  escrowAddress,
  parseTarget,
  args,
} from "./chain.mjs";
import { verifyPullRequest } from "./verify.mjs";

const arg = args();
const bountyId = arg.value("bounty");
const prTarget = arg.value("pr");
const send = arg.has("send");

if (!bountyId || !prTarget) {
  console.error("uso: node settle.mjs --bounty <id> --pr <url|owner/repo#n> [--developer 0x...] [--send]");
  process.exit(2);
}

const target = parseTarget(prTarget) ?? fail(`no entiendo el pull request: ${prTarget}`);

const secrets = loadSecrets();
const developer = arg.value("developer") ?? secrets?.developer?.address;
if (!developer) fail("falta la dirección del desarrollador: pásala con --developer 0x...");

const contract = { address: escrowAddress(), abi: ABI };

// ───────────────────────── 1. ¿Existe el trabajo? ──────────────────

console.log("1. verificando el pull request\n");
const result = await verifyPullRequest(target);
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
  fail(`el bounty ${bountyId} no existe en ${contract.address}`);
}

const [payout, fee] = await publicClient.readContract({
  ...contract,
  functionName: "quote",
  args: [bounty.amount],
});

console.log(`   escrow     : ${contract.address}`);
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
