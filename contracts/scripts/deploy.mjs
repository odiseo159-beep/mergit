import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const FEE_BPS = 150; // 1.5%

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const account = privateKeyToAccount(secrets.deployer.privateKey);

const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitEscrow.sol/MergitEscrow.json", import.meta.url),
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

const feeRecipient = account.address; // tesorería del protocolo (testnet)

console.log("desplegando MergitEscrow…");
console.log("  deployer     :", account.address);
console.log("  saldo        :", formatEther(await publicClient.getBalance({ address: account.address })), "ETH");
console.log("  feeBps       :", FEE_BPS, "(1.5%)");
console.log("  feeRecipient :", feeRecipient);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [FEE_BPS, feeRecipient],
});
console.log("\ntx enviada:", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;

console.log("\n✓ desplegado");
console.log("  contrato :", address);
console.log("  bloque   :", receipt.blockNumber);
console.log("  gas      :", receipt.gasUsed);
console.log("  explorer :", `${giwaSepolia.blockExplorers.default.url}/address/${address}`);

writeFileSync(
  new URL("../deployment.json", import.meta.url),
  JSON.stringify(
    {
      network: "giwa-sepolia",
      chainId: 91342,
      contract: "MergitEscrow",
      address,
      deployer: account.address,
      constructorArgs: [FEE_BPS, feeRecipient],
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      explorer: `${giwaSepolia.blockExplorers.default.url}/address/${address}`,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("\nescrito contracts/deployment.json");
