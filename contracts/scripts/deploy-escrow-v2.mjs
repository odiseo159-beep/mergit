// Despliega MergitEscrowV2 en GIWA Sepolia y deja el registro en
// contracts/deployment-v2.json.
//
// La v1 sigue viva y es donde ocurrieron los pagos que se muestran: esta no la
// reemplaza, la acompaña. El agente elige cuál usar por su dirección.
//
//   node scripts/deploy-escrow-v2.mjs
//
// Firma con la clave de WALLETS.secret.json, así que solo se corre a mano.
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const FEE_BPS = 150; // 1.5%, el mismo de la v1

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const account = privateKeyToAccount(secrets.deployer.privateKey);

const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitEscrowV2.sol/MergitEscrowV2.json", import.meta.url),
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

console.log("desplegando MergitEscrowV2 (escrow con ventana de objeción)…");
console.log("  deployer :", account.address);
console.log(
  "  saldo    :",
  formatEther(await publicClient.getBalance({ address: account.address })),
  "ETH",
);
console.log("  feeBps       :", FEE_BPS, "(1.5%, igual que la v1)");
console.log("  feeRecipient :", account.address);

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
  new URL("../deployment-v2.json", import.meta.url),
  JSON.stringify(
    {
      network: "giwa-sepolia",
      chainId: 91342,
      contract: "MergitEscrowV2",
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
console.log("\nescrito contracts/deployment-v2.json");
console.log("Verificar después con:\n  npx hardhat verify --network giwaSepolia", address);
