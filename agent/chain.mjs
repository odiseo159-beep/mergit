// Todo lo que el agente necesita saber de la cadena y del contrato, en un solo
// sitio: la definición de GIWA Sepolia, el ABI mínimo de MergitEscrow y de
// dónde salen la dirección del escrow y las cuentas.
import { createPublicClient, http } from "viem";
import { readFileSync, existsSync } from "node:fs";

export const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
};

export const EXPLORER = giwaSepolia.blockExplorers.default.url;

// Estados del enum Status del contrato, en su orden.
export const STATUS = ["None", "Open", "Settled", "Refunded"];

// Solo lo que el agente usa. Así este directorio no depende de que alguien
// haya compilado los contratos antes.
export const ABI = [
  {
    type: "function",
    name: "postBounty",
    stateMutability: "payable",
    inputs: [
      { name: "verifier", type: "address" },
      { name: "deadline", type: "uint64" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "bountyId", type: "uint256" }],
  },
  {
    type: "function",
    name: "getBounty",
    stateMutability: "view",
    inputs: [{ name: "bountyId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "funder", type: "address" },
          { name: "verifier", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint64" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [
      { name: "payout", type: "uint256" },
      { name: "fee", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bountyId", type: "uint256" },
      { name: "developer", type: "address" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "BountyPosted",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "funder", type: "address", indexed: true },
      { name: "verifier", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BountySettled",
    inputs: [
      { name: "bountyId", type: "uint256", indexed: true },
      { name: "developer", type: "address", indexed: true },
      { name: "verifier", type: "address", indexed: true },
      { name: "paidToDeveloper", type: "uint256", indexed: false },
      { name: "protocolFee", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
    ],
  },
];

export const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });

export function fail(msg) {
  console.error(`\nabortado: ${msg}`);
  process.exit(1);
}

/** Claves de testnet. El archivo está fuera del repo y nunca se imprime. */
export function loadSecrets() {
  const path = new URL("../WALLETS.secret.json", import.meta.url);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function escrowAddress() {
  if (process.env.MERGIT_ESCROW) return process.env.MERGIT_ESCROW;
  const path = new URL("../contracts/deployment.json", import.meta.url);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")).address;
  return fail("no sé dónde está el escrow. Define MERGIT_ESCROW o deja contracts/deployment.json en su sitio.");
}

/** Acepta la URL del pull request o la forma corta owner/repo#123. */
export function parseTarget(raw) {
  const url = raw?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const short = raw?.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  return null;
}

/** Lector de banderas del estilo --nombre valor. */
export function args(argv = process.argv.slice(2)) {
  return {
    value: (name) => {
      const i = argv.indexOf(`--${name}`);
      return i === -1 ? null : argv[i + 1];
    },
    has: (name) => argv.includes(`--${name}`),
    positional: () => argv.filter((a) => !a.startsWith("--")),
  };
}
