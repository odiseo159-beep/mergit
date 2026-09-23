// Despliega MergitRegistry en GIWA Sepolia y deja el registro en
// contracts/registry.json, que es de donde lo lee el agente.
//
//   node scripts/deploy-registry.mjs
//
// Firma con la clave de WALLETS.secret.json, así que solo se corre a mano.
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const account = privateKeyToAccount(secrets.deployer.privateKey);

const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitRegistry.sol/MergitRegistry.json", import.meta.url),
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

console.log("desplegando MergitRegistry…");
console.log("  deployer :", account.address);
console.log(
  "  saldo    :",
  formatEther(await publicClient.getBalance({ address: account.address })),
  "ETH",
);
console.log("  sin argumentos: el registro no tiene dueño ni parámetros");

const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
console.log("\ntx enviada:", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;

console.log("\n✓ desplegado");
console.log("  contrato :", address);
console.log("  bloque   :", receipt.blockNumber);
console.log("  gas      :", receipt.gasUsed);
console.log("  explorer :", `${giwaSepolia.blockExplorers.default.url}/address/${address}`);

writeFileSync(
  new URL("../registry.json", import.meta.url),
  JSON.stringify(
    {
      network: "giwa-sepolia",
      chainId: 91342,
      contract: "MergitRegistry",
      address,
      deployer: account.address,
      constructorArgs: [],
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      explorer: `${giwaSepolia.blockExplorers.default.url}/address/${address}`,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("\nescrito contracts/registry.json");
console.log("Verificar después con:\n  npx hardhat verify --network giwaSepolia", address);
