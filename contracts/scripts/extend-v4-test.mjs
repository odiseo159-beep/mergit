// Alarga un día el plazo de un bounty de prueba de MergitEscrowV4.
//
//   node scripts/extend-v4-test.mjs 1            simula, no firma
//   node scripts/extend-v4-test.mjs 1 --send     firma y envía
//
// Existe porque el bounty #1 de la v4 (publicado el 23-nov con plazo de 1 día) venció
// antes del pago de prueba. Firma el financiador, que puede mover el plazo sin tope;
// solo mientras el bounty está `Open`. Después, el pago de prueba sigue igual:
// settle, 180 s de ventana, finalize.
import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const { address: ESCROW, contract: CONTRATO } = JSON.parse(
  readFileSync(new URL("../deployment-v4.json", import.meta.url), "utf8"),
);
if (CONTRATO !== "MergitEscrowV4") throw new Error("deployment-v4.json no es de la v4");
const FUNDER = "0x23E8541dA96158d342477D694274E27639807686";

const id = BigInt(process.argv[2] ?? "");
const { abi } = JSON.parse(
  readFileSync(new URL("../artifacts/contracts/MergitEscrowV4.sol/MergitEscrowV4.json", import.meta.url), "utf8"),
);
const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
};
const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });

const b = await publicClient.readContract({ address: ESCROW, abi, functionName: "getBounty", args: [id] });
if (b.funder.toLowerCase() !== FUNDER.toLowerCase()) throw new Error(`el bounty #${id} no lo financió ${FUNDER}`);
const nuevo = BigInt(Math.floor(Date.now() / 1000) + 86400);

console.log(`Escrow v4 · alargar el bounty #${id}`);
console.log("  escrow       :", ESCROW);
console.log("  plazo actual :", new Date(Number(b.deadline) * 1000).toISOString());
console.log("  plazo nuevo  :", new Date(Number(nuevo) * 1000).toISOString());

await publicClient.simulateContract({ account: FUNDER, address: ESCROW, abi, functionName: "extend", args: [id, nuevo] });

if (!process.argv.includes("--send")) {
  console.log("\nLa simulación pasa. Nada se firmó. Vuelve a correrlo con --send.");
  process.exit(0);
}

const secrets = JSON.parse(readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(secrets.developer.privateKey);
if (account.address !== FUNDER) throw new Error("la clave developer no corresponde a la wallet financiadora");

const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract({ address: ESCROW, abi, functionName: "extend", args: [id, nuevo] });
console.log("\ntx enviada:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const [ev] = parseEventLogs({ abi, logs: receipt.logs, eventName: "DeadlineExtended" });
console.log(receipt.status === "success" && ev ? `✓ plazo del bounty #${id} movido` : "✗ revertida");
console.log(`  https://sepolia-explorer.giwa.io/tx/${hash}`);
