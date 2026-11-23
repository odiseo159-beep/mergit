// Publica el primer bounty de prueba en MergitEscrowV4.
//
//   node scripts/post-v4-test.mjs            simula, no firma
//   node scripts/post-v4-test.mjs --send     firma y envía
//
// Existe porque `escrowFlavor` reconoce la v3 y la v4 leyendo el bounty #1: en una recién
// desplegada ese bounty no existe, la toma por una v2 y `post-bounty.mjs` usaría la
// firma equivocada. Desde el segundo bounty, el camino normal funciona.
//
// Financia la wallet del developer y verifica el agente, para que financiador y
// verificador sean cuentas distintas. Ventana de 180 s, plazo de 1 día, tope de 7.
import { createPublicClient, createWalletClient, http, parseEther, formatEther, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

// De lo que dejó el despliegue, para no publicar nunca en otra versión por error.
const { address: ESCROW, contract: CONTRATO } = JSON.parse(
  readFileSync(new URL("../deployment-v4.json", import.meta.url), "utf8"),
);
if (CONTRATO !== "MergitEscrowV4") throw new Error("deployment-v4.json no es de la v4");
const FUNDER = "0x23E8541dA96158d342477D694274E27639807686";
const VERIFIER = "0x28Df38871Ef4BeeBd6B0d8Cd6D4c99Bf4FE3852b";
const URI = "https://github.com/odiseo159-beep/mergit-demo/issues/4";
const AMOUNT = parseEther("0.0005");
const WINDOW = 180;

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

const ahora = Math.floor(Date.now() / 1000);
const args = [VERIFIER, BigInt(ahora + 86400), BigInt(ahora + 7 * 86400), WINDOW, URI];

console.log("Escrow v4 · bounty de prueba");
console.log("  escrow   :", ESCROW);
console.log("  financia :", FUNDER);
console.log("  verifica :", VERIFIER);
console.log("  monto    :", formatEther(AMOUNT), "ETH de prueba");
console.log("  ventana  :", WINDOW, "s");
console.log("  saldo    :", formatEther(await publicClient.getBalance({ address: FUNDER })), "ETH de prueba");

await publicClient.simulateContract({ account: FUNDER, address: ESCROW, abi, functionName: "postBounty", args, value: AMOUNT });

if (!process.argv.includes("--send")) {
  console.log("\nLa simulación pasa. Nada se firmó. Vuelve a correrlo con --send.");
  process.exit(0);
}

const secrets = JSON.parse(readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(secrets.developer.privateKey);
if (account.address !== FUNDER) throw new Error("la clave developer no corresponde a la wallet financiadora");

const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });
const hash = await wallet.writeContract({ address: ESCROW, abi, functionName: "postBounty", args, value: AMOUNT });
console.log("\ntx enviada:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const [ev] = parseEventLogs({ abi, logs: receipt.logs, eventName: "BountyPosted" });
console.log(receipt.status === "success" ? `✓ bounty #${ev.args.bountyId} publicado` : "✗ revertida");
console.log(`  https://sepolia-explorer.giwa.io/tx/${hash}`);
