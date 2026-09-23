// Reclamar un login de GitHub desde tu propia wallet.
//
//   node claim.mjs --login odiseo159-beep --proof https://gist.github.com/odiseo159-beep/abc123
//   node claim.mjs --login odiseo159-beep --proof <url> --send
//   node claim.mjs --who odiseo159-beep         (solo mirar quién lo tiene)
//
// La prueba es una publicación tuya en GitHub que contenga tu dirección: un gist,
// o el README del repositorio que lleva tu propio nombre. El script la comprueba
// antes de firmar nada: reclamar con una prueba rota solo gasta gas y deja una
// afirmación que el agente va a rechazar igual.
//
// Sin --send no se firma: simula la transacción y cuenta qué pasaría.
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { giwaSepolia, EXPLORER, publicClient, fail, loadSecrets, args } from "./chain.mjs";
import { REGISTRY_ABI, registryAddress, claimFor, checkProof } from "./registry.mjs";

const arg = args();

const address = registryAddress();
if (!address) fail("no encuentro el registro: despliega MergitRegistry o define MERGIT_REGISTRY");

// ── solo mirar ────────────────────────────────────────────────────────
const who = arg.value("who");
if (who) {
  const claim = await claimFor(who);
  if (!claim) {
    console.log(`@${who} no ha reclamado su login todavía.`);
    process.exit(0);
  }
  const proof = await checkProof(claim);
  console.log(`@${who}`);
  console.log(`  wallet   : ${claim.wallet}`);
  console.log(`  desde    : ${new Date(claim.claimedAt * 1000).toISOString()}`);
  console.log(`  prueba   : ${claim.proofURI}`);
  console.log(`  ¿válida? : ${proof.ok ? `sí, ${proof.where}` : `no — ${proof.reason}`}`);
  process.exit(proof.ok ? 0 : 1);
}

// ── reclamar ──────────────────────────────────────────────────────────
const login = arg.value("login");
const proofURI = arg.value("proof");
const send = arg.has("send");

if (!login || !proofURI) {
  console.error("uso: node claim.mjs --login <github> --proof <url> [--send]");
  console.error("     node claim.mjs --who <github>");
  process.exit(2);
}

const key = process.env.MERGIT_DEV_KEY || loadSecrets()?.developer?.privateKey;
if (!key) fail("falta la clave de tu wallet: define MERGIT_DEV_KEY");
const account = privateKeyToAccount(key);

console.log("1. comprobando la prueba\n");
console.log(`   login  : ${login}`);
console.log(`   wallet : ${account.address}`);
console.log(`   prueba : ${proofURI}`);

const proof = await checkProof({ login, wallet: account.address, proofURI });
if (!proof.ok) {
  console.log(`\n   la prueba no se sostiene: ${proof.reason}`);
  console.log("\n   Publica tu dirección en un gist tuyo, o en el README del repositorio");
  console.log(`   github.com/${login}/${login}, y vuelve a intentarlo.`);
  process.exit(1);
}
console.log(`   válida: ${proof.where}\n`);

console.log("2. revisando el registro\n");
const taken = await claimFor(login);
if (taken && taken.wallet.toLowerCase() !== account.address.toLowerCase()) {
  fail(`@${login} ya está reclamado por ${taken.wallet}`);
}
console.log(taken ? "   ya es tuyo: esto actualizará la prueba\n" : "   libre\n");

console.log("3. simulando la reclamación\n");
const { request } = await publicClient.simulateContract({
  address,
  abi: REGISTRY_ABI,
  functionName: "claim",
  args: [login, proofURI],
  account,
});
console.log("   la cadena acepta la transacción\n");

if (!send) {
  console.log("ensayo, no se firmó nada. Repite con --send para reclamar de verdad.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash });

console.log(`4. reclamado en el bloque ${receipt.blockNumber} (gas ${receipt.gasUsed})\n`);
console.log(`   ${EXPLORER}/tx/${hash}`);
console.log(`\nDesde ahora, los bounties de @${login} se pagan a ${account.address}.`);
