import { createPublicClient, http, formatEther } from "viem";
import { readFileSync } from "node:fs";

const secrets = JSON.parse(
  readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"),
);
const address = secrets.deployer.address;

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" },
  },
};

const client = createPublicClient({ chain: giwaSepolia, transport: http() });

const [balance, chainId, block] = await Promise.all([
  client.getBalance({ address }),
  client.getChainId(),
  client.getBlockNumber(),
]);

console.log("red        :", giwaSepolia.name, "· chainId", chainId, "· bloque", block);
console.log("dirección  :", address);
console.log("saldo      :", formatEther(balance), "ETH");
console.log(
  balance === 0n
    ? "\n→ sin fondos todavía. Reclama en https://faucet.giwa.io o https://faucet.lambda256.io/giwa-sepolia"
    : "\n✓ fondeada, lista para desplegar",
);
