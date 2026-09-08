// Publica un bounty en GIWA Sepolia bloqueando el ETH enviado.
//
// En producción esto lo hace el protocolo que financia, no el agente. Aquí
// sirve para dejar un bounty abierto contra el que probar la liquidación.
//
//   node post-bounty.mjs --uri "github.com/owner/repo/issues/1"
//   node post-bounty.mjs --uri "..." --amount 0.0005 --days 7 --send
//
// Sin --send simula contra la cadena y no firma nada.
import { createWalletClient, http, formatEther, parseEther, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  giwaSepolia,
  EXPLORER,
  ABI,
  publicClient,
  fail,
  loadSecrets,
  escrowAddress,
  args,
} from "./chain.mjs";

const arg = args();
const metadataURI = arg.value("uri");
const amount = parseEther(arg.value("amount") ?? "0.0005");
const days = Number(arg.value("days") ?? 7);
const send = arg.has("send");

if (!metadataURI) {
  console.error('uso: node post-bounty.mjs --uri "<referencia del trabajo>" [--amount 0.0005] [--days 7] [--send]');
  process.exit(2);
}

const secrets = loadSecrets();
const funderKey = secrets?.deployer?.privateKey;
if (!funderKey) fail("no encuentro la clave en WALLETS.secret.json");

const funder = privateKeyToAccount(funderKey);
// En la demo de testnet el financiador y el verificador son la misma cuenta.
// Es una limitación conocida y está declarada en /docs: en producción son
// partes distintas, y el contrato ya lo soporta sin cambios.
const verifier = arg.value("verifier") ?? funder.address;
const deadline = BigInt(Math.floor(Date.now() / 1000) + days * 86400);

const contract = { address: escrowAddress(), abi: ABI };
const balance = await publicClient.getBalance({ address: funder.address });

console.log(`escrow      : ${contract.address}`);
console.log(`financiador : ${funder.address} (saldo ${formatEther(balance)} ETH)`);
console.log(`verificador : ${verifier}`);
console.log(`importe     : ${formatEther(amount)} ETH`);
console.log(`plazo       : ${days} días`);
console.log(`trabajo     : ${metadataURI}\n`);

if (balance < amount) fail(`saldo insuficiente: hacen falta ${formatEther(amount)} ETH más el gas`);

const { request } = await publicClient.simulateContract({
  ...contract,
  functionName: "postBounty",
  args: [verifier, deadline, metadataURI],
  value: amount,
  account: funder,
});
console.log("la cadena acepta la transacción\n");

if (!send) {
  console.log("ensayo, no se firmó nada. Repite con --send para publicar el bounty.");
  process.exit(0);
}

const wallet = createWalletClient({ account: funder, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract(request);
console.log(`tx enviada : ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`confirmada en el bloque ${receipt.blockNumber}\n`);

for (const log of receipt.logs) {
  try {
    const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
    if (event.eventName !== "BountyPosted") continue;
    console.log(`bounty #${event.args.bountyId} abierto con ${formatEther(event.args.amount)} ETH bloqueados`);
    console.log(`\nliquídalo con:\n  node settle.mjs --bounty ${event.args.bountyId} --pr <url del PR> --send`);
  } catch {
    // Un log ajeno en el mismo recibo.
  }
}

console.log(`\n${EXPLORER}/tx/${hash}`);
