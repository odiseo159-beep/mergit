// Despliega MergitEscrowV3 en GIWA Sepolia y deja el registro en
// contracts/deployment-v3.json.
//
// Ni la v1 ni la v2 se retiran: las tres conviven y el agente elige por la
// dirección. La v1 es la que tiene la historia de pagos que se enseña.
//
//   node scripts/deploy-escrow-v3.mjs            lee y dice qué haría
//   node scripts/deploy-escrow-v3.mjs --send     firma y despliega
//
// Sin --send no envía nada. Firma con la clave de WALLETS.secret.json, así que
// esto se corre a mano y nunca desde CI.
//
// Lo que trae la v3 es `extend`: el plazo se puede mover hacia adelante. Nació
// del 25 de octubre de 2026, cuando dos bounties vencieron con cuatro pull
// requests listos porque faltó aprobar un workflow a tiempo.
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const FEE_BPS = 150; // 1.5%, el mismo de la v1

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const account = privateKeyToAccount(secrets.deployer.privateKey);

const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitEscrowV3.sol/MergitEscrowV3.json", import.meta.url),
    "utf8",
  ),
);

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" },
  },
};

const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
const wallet = createWalletClient({ account, chain: giwaSepolia, transport: http() });

const send = process.argv.includes("--send");

console.log("MergitEscrowV3 — escrow con plazo extensible");
console.log("  modo     :", send ? "FIRMA Y DESPLIEGA" : "solo lectura (añade --send)");
console.log("  deployer :", account.address);
console.log(
  "  saldo    :",
  formatEther(await publicClient.getBalance({ address: account.address })),
  "ETH",
);
console.log("  feeBps       :", FEE_BPS, "(1.5%, igual que la v1)");
console.log("  feeRecipient :", account.address);

if (!send) {
  // Con los argumentos del constructor dentro, que si no la estimación falla y
  // el ensayo no sirve de nada: lo que se quiere saber es cuánto va a costar.
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [FEE_BPS, account.address] });
  const gas = await publicClient.estimateGas({ account, data }).catch(() => null);
  const precio = await publicClient.getGasPrice().catch(() => null);
  if (gas && precio) {
    console.log("\ncoste estimado:", formatEther(gas * precio), "ETH");
  }
  console.log("\ngas estimado:", gas ? String(gas) : "(no se pudo estimar)");
  console.log("nada se firmó. Vuelve a correrlo con --send cuando quieras desplegarlo.");
  process.exit(0);
}

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [FEE_BPS, account.address] });
console.log("\ntx enviada:", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;

console.log("\n✓ desplegado");
console.log("  contrato :", address);
console.log("  bloque   :", receipt.blockNumber);
console.log("  gas      :", receipt.gasUsed);
console.log("  explorer :", `${giwaSepolia.blockExplorers.default.url}/address/${address}`);

writeFileSync(
  new URL("../deployment-v3.json", import.meta.url),
  JSON.stringify(
    {
      network: "giwa-sepolia",
      chainId: 91342,
      contract: "MergitEscrowV3",
      address,
      deployer: account.address,
      constructorArgs: [FEE_BPS, account.address],
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      explorer: `${giwaSepolia.blockExplorers.default.url}/address/${address}`,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("\nescrito contracts/deployment-v3.json");
console.log("Verificar después con:\n  npx hardhat verify --network giwaSepolia", address);
