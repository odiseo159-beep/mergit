// Cierra un pago pendiente de MergitEscrowV2: el que ya pasó su ventana de objeción.
//
//   node scripts/finalize-v2.mjs            lee el bounty #1 y simula, no firma
//   node scripts/finalize-v2.mjs --send     firma y envía
//   node scripts/finalize-v2.mjs 3 --send   lo mismo con otro bounty
//
// `finalize` no elige nada: paga al developer ya propuesto y cobra la comisión fija.
// Cualquiera puede llamarlo. Firma con la clave de WALLETS.secret.json, que solo se
// lee con --send, así que esto se corre a mano y nunca desde CI.
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const ESCROW = "0x48d506080abdbed11f1acbe40f799301d9612ad5";
const ESTADOS = ["None", "Open", "Pending", "Settled", "Refunded"];
const SIMULA_DESDE = "0x28Df38871Ef4BeeBd6B0d8Cd6D4c99Bf4FE3852b";

const abi = [
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ name: "bountyId", type: "uint256" }], outputs: [] },
  { type: "function", name: "quote", stateMutability: "view", inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "payout", type: "uint256" }, { name: "fee", type: "uint256" }] },
  { type: "function", name: "getBounty", stateMutability: "view", inputs: [{ name: "bountyId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "funder", type: "address" }, { name: "verifier", type: "address" }, { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint64" }, { name: "challengeWindow", type: "uint32" }, { name: "status", type: "uint8" },
      { name: "developer", type: "address" }, { name: "claimableAt", type: "uint64" }, { name: "challenged", type: "bool" },
      { name: "evidenceHash", type: "bytes32" }] }] },
];

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
};

const send = process.argv.includes("--send");
const id = BigInt(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 1);
const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });

const b = await publicClient.readContract({ address: ESCROW, abi, functionName: "getBounty", args: [id] });
const [payout, fee] = await publicClient.readContract({ address: ESCROW, abi, functionName: "quote", args: [b.amount] });

console.log(`Escrow v2 · bounty #${id}`);
console.log("  estado    :", ESTADOS[b.status]);
console.log("  developer :", b.developer);
console.log("  paga      :", formatEther(payout), "ETH de prueba");
console.log("  comisión  :", formatEther(fee), "ETH de prueba");
console.log("  cobrable  :", new Date(Number(b.claimableAt) * 1000).toISOString());

if (ESTADOS[b.status] !== "Pending") {
  console.log("\nNo está pendiente: no hay nada que finalizar.");
  process.exit(1);
}

if (!send) {
  await publicClient.simulateContract({ account: SIMULA_DESDE, address: ESCROW, abi, functionName: "finalize", args: [id] });
  console.log("\nLa simulación pasa. Nada se firmó. Vuelve a correrlo con --send.");
  process.exit(0);
}

const secrets = JSON.parse(readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(secrets.deployer.privateKey);
const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });

const hash = await wallet.writeContract({ address: ESCROW, abi, functionName: "finalize", args: [id] });
console.log("\ntx enviada:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(receipt.status === "success" ? "✓ pagado" : "✗ revertida", "· bloque", String(receipt.blockNumber));
console.log(`  https://sepolia-explorer.giwa.io/tx/${hash}`);
