// Devuelve al financiador el ETH de un bounty que venció sin pagarse.
//
//   node refund.mjs --bounty 9,10
//   node refund.mjs --bounty 9,10 --send
//
// Sin --send no firma nada: lee el estado, dice si se puede y por qué.
//
// El contrato solo deja llamarlo al financiador y solo pasado el plazo
// (`MergitEscrow.refund`). Esas dos cosas se comprueban aquí antes de gastar
// gas, para que el error llegue en castellano y no como un revert.
//
// Pasa cuando el trabajo llegó pero nadie lo mergeó a tiempo: el 25 de octubre
// los bounties #9 y #10 vencieron con cuatro pull requests listos, porque el CI
// de un contribuidor primerizo necesita que alguien apruebe el workflow a mano.
// Esto recupera el dinero; reponer el bounty es el paso siguiente.
import { createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  giwaSepolia, EXPLORER, escrowFlavor,
  publicClient, fail, loadSecrets, escrowAddress, args,
} from "./chain.mjs";

const REFUND_ABI = [{
  type: "function",
  name: "refund",
  stateMutability: "nonpayable",
  inputs: [{ name: "bountyId", type: "uint256" }],
  outputs: [],
}];

const arg = args();
const lista = String(arg.value("bounty") ?? "")
  .split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const send = arg.has("send");

if (!lista.length) {
  console.error("uso: node refund.mjs --bounty 9,10 [--send]");
  console.error("     sin --send solo informa, no firma nada.");
  process.exit(2);
}

const secrets = loadSecrets();
// El financiador de los bounties #9 y #10 es la wallet `developer`, no la del
// agente: se hicieron así a propósito, para que quien paga y quien verifica no
// fueran la misma cuenta. Se puede forzar otra con --account.
const cual = arg.value("account") ?? "developer";
const key = secrets?.[cual]?.privateKey;
if (!key) fail(`no encuentro la clave de "${cual}" en WALLETS.secret.json`);
const cuenta = privateKeyToAccount(key);

const address = escrowAddress();
const flavor = await escrowFlavor(address);
const nombres = flavor.status;
const contrato = { address, abi: [...flavor.abi, ...REFUND_ABI] };

console.log(`escrow   : ${address} (${flavor.v2 ? "v2" : "v1"})`);
console.log(`cuenta   : ${cuenta.address}`);
console.log(`modo     : ${send ? "FIRMA Y ENVÍA" : "solo lectura"}\n`);

const wallet = send
  ? createWalletClient({ account: cuenta, chain: giwaSepolia, transport: http() })
  : null;

const ahora = Math.floor(Date.now() / 1000);
let devueltos = 0n;

for (const id of lista) {
  const b = await publicClient.readContract({ ...contrato, functionName: "getBounty", args: [BigInt(id)] });
  const estado = nombres[Number(b.status)] ?? String(b.status);
  const vence = new Date(Number(b.deadline) * 1000).toISOString().slice(0, 16) + "Z";
  console.log(`bounty #${id} · ${estado} · ${formatEther(b.amount)} ETH · venció ${vence}`);

  if (estado !== "Open") {
    console.log(`   nada que devolver: ya está ${estado.toLowerCase()}\n`);
    continue;
  }
  if (b.funder.toLowerCase() !== cuenta.address.toLowerCase()) {
    console.log(`   solo lo puede devolver quien lo financió: ${b.funder}\n`);
    continue;
  }
  if (Number(b.deadline) >= ahora) {
    const faltan = ((Number(b.deadline) - ahora) / 3600).toFixed(1);
    console.log(`   todavía no vence, faltan ${faltan} h. Hasta entonces el agente aún puede pagar\n`);
    continue;
  }

  if (!send) {
    await publicClient.simulateContract({ ...contrato, functionName: "refund", args: [BigInt(id)], account: cuenta });
    console.log(`   se puede devolver. Añade --send para firmarlo\n`);
    devueltos += b.amount;
    continue;
  }

  const { request } = await publicClient.simulateContract({
    ...contrato, functionName: "refund", args: [BigInt(id)], account: cuenta,
  });
  const hash = await wallet.writeContract(request);
  console.log(`   enviado: ${EXPLORER}/tx/${hash}`);
  const recibo = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   ${recibo.status === "success" ? "devuelto" : "FALLÓ"} en el bloque ${recibo.blockNumber}\n`);
  if (recibo.status === "success") devueltos += b.amount;
}

console.log(`total ${send ? "devuelto" : "devolvible"}: ${formatEther(devueltos)} ETH`);
if (!send && devueltos > 0n) console.log("\nnada se firmó. Vuelve a correrlo con --send cuando quieras hacerlo.");
