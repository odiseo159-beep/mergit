// Despliega MergitEscrowV4 en GIWA Sepolia y deja el registro en
// contracts/deployment-v4.json.
//
// Ni la v1, ni la v2, ni la v3 se retiran: las cuatro conviven y el agente elige por la
// dirección. La v1 es la que tiene la historia de pagos que se enseña.
//
//   node scripts/deploy-escrow-v4.mjs            lee y dice qué haría
//   node scripts/deploy-escrow-v4.mjs --send     firma y despliega
//
// Sin --send no envía nada. Firma con la clave de WALLETS.secret.json, así que
// esto se corre a mano y nunca desde CI.
//
// Lo que trae la v4: un pago aprobado ya no se puede quedar atascado si la dirección
// del developer rechaza ETH. Lo encontró Aegis en la v3 el 23 de noviembre de 2026.
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const FEE_BPS = 150; // 1.5%, el mismo de la v1
// Inmutable una vez desplegado. No es la cuenta del agente: esa clave vive en los
// secretos de GitHub, y una comisión no debe depender de que nunca se filtre.
const FEE_RECIPIENT = "0x23E8541dA96158d342477D694274E27639807686";

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const account = privateKeyToAccount(secrets.deployer.privateKey);

const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitEscrowV4.sol/MergitEscrowV4.json", import.meta.url),
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

console.log("MergitEscrowV4 — escrow sin pagos atascados");
console.log("  modo     :", send ? "FIRMA Y DESPLIEGA" : "solo lectura (añade --send)");
console.log("  deployer :", account.address);
console.log(
  "  saldo    :",
  formatEther(await publicClient.getBalance({ address: account.address })),
  "ETH",
);
console.log("  feeBps       :", FEE_BPS, "(1.5%, igual que la v1)");
console.log("  feeRecipient :", FEE_RECIPIENT);

if (!send) {
  // Con los argumentos del constructor dentro, que si no la estimación falla y
  // el ensayo no sirve de nada: lo que se quiere saber es cuánto va a costar.
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [FEE_BPS, FEE_RECIPIENT] });
  const gas = await publicClient.estimateGas({ account, data }).catch(() => null);
  const precio = await publicClient.getGasPrice().catch(() => null);
  if (gas && precio) {
    console.log("\ncoste estimado:", formatEther(gas * precio), "ETH");
  }
  console.log("\ngas estimado:", gas ? String(gas) : "(no se pudo estimar)");
  console.log("nada se firmó. Vuelve a correrlo con --send cuando quieras desplegarlo.");
  process.exit(0);
}

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [FEE_BPS, FEE_RECIPIENT] });
console.log("\ntx enviada:", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;

console.log("\n✓ desplegado");
console.log("  contrato :", address);
console.log("  bloque   :", receipt.blockNumber);
console.log("  gas      :", receipt.gasUsed);
console.log("  explorer :", `${giwaSepolia.blockExplorers.default.url}/address/${address}`);

writeFileSync(
  new URL("../deployment-v4.json", import.meta.url),
  JSON.stringify(
    {
      network: "giwa-sepolia",
      chainId: 91342,
      contract: "MergitEscrowV4",
      address,
      deployer: account.address,
      constructorArgs: [FEE_BPS, FEE_RECIPIENT],
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      explorer: `${giwaSepolia.blockExplorers.default.url}/address/${address}`,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("\nescrito contracts/deployment-v4.json");
console.log("Verificar después con:\n  npx hardhat verify --network giwaSepolia", address, FEE_BPS, FEE_RECIPIENT);
