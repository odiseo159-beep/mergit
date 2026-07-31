// Ejecuta el ciclo completo de Mergit en GIWA Sepolia:
// publicar un bounty con fondos bloqueados → el agente verificador lo liquida
// al desarrollador, dejando la evidencia registrada on-chain.
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  keccak256,
  toHex,
  decodeEventLog,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const SECRETS = new URL("../../WALLETS.secret.json", import.meta.url);
const secrets = JSON.parse(readFileSync(SECRETS, "utf8"));
const deployment = JSON.parse(readFileSync(new URL("../deployment.json", import.meta.url), "utf8"));
const artifact = JSON.parse(
  readFileSync(
    new URL("../artifacts/contracts/MergitEscrow.sol/MergitEscrow.json", import.meta.url),
    "utf8",
  ),
);

// El "desarrollador" que cobra el bounty: cuenta aparte, para que el flujo
// de fondos en el explorer sea legible (agente → desarrollador).
if (!secrets.developer) {
  const pk = generatePrivateKey();
  secrets.developer = { address: privateKeyToAccount(pk).address, privateKey: pk };
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  console.log("→ cuenta de desarrollador creada:", secrets.developer.address);
}

const agent = privateKeyToAccount(secrets.deployer.privateKey);
const developerAddress = secrets.developer.address;

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
};
const EXPLORER = giwaSepolia.blockExplorers.default.url;

const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
const wallet = createWalletClient({ account: agent, chain: giwaSepolia, transport: http() });

const contract = { address: deployment.address, abi: artifact.abi };
const BOUNTY = parseEther("0.0005");

console.log("contrato :", deployment.address);
console.log("agente   :", agent.address);
console.log("developer:", developerAddress);
console.log("saldo    :", formatEther(await publicClient.getBalance({ address: agent.address })), "ETH\n");

// Permite liquidar un bounty ya publicado:  node scripts/demo-tx.mjs --settle 1
const settleOnlyIdx = process.argv.indexOf("--settle");
const settleOnly = settleOnlyIdx !== -1 ? BigInt(process.argv[settleOnlyIdx + 1]) : null;

let bountyId;
let postHash = null;

if (settleOnly !== null) {
  bountyId = settleOnly;
  console.log("1/2 (omitido) usando el bounty existente #" + bountyId);
} else {
  // ── 1. publicar el bounty ──────────────────────────────────────
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30); // +30 días
  postHash = await wallet.writeContract({
    ...contract,
    functionName: "postBounty",
    args: [agent.address, deadline, process.env.MERGIT_TASK ?? "github.com/odiseo159-beep/celo-sentinel"],
    value: BOUNTY,
  });
  console.log("1/2 postBounty →", postHash);
  const postReceipt = await publicClient.waitForTransactionReceipt({ hash: postHash });
  console.log("    bloque", postReceipt.blockNumber, "· gas", postReceipt.gasUsed);

  // El id se toma del evento del recibo: leer nextBountyId por RPC puede
  // devolver estado rezagado justo después de minar.
  for (const log of postReceipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
      if (parsed.eventName === "BountyPosted") bountyId = parsed.args.bountyId;
    } catch {
      /* log de otro contrato */
    }
  }
  if (bountyId === undefined) throw new Error("no se encontró el evento BountyPosted en el recibo");
  console.log("    bountyId:", bountyId, "(leído del evento)");
}

console.log(
  "    escrow bloqueado:",
  formatEther(await publicClient.getBalance({ address: deployment.address })),
  "ETH",
);

// ── 2. el agente verifica y libera ───────────────────────────────
// La evidencia es la huella de lo que el agente evaluó realmente.
const evidence =
  process.env.MERGIT_EVIDENCE ??
  "repo:odiseo159-beep/celo-sentinel|task:giwa-escrow-demo|verifier:mergit-agent-v0";
const evidenceHash = keccak256(toHex(evidence));
console.log("\n    evidencia :", evidence);
console.log("    hash      :", evidenceHash);

const settleHash = await wallet.writeContract({
  ...contract,
  functionName: "settle",
  args: [bountyId, developerAddress, evidenceHash],
});
console.log("\n2/2 settle →", settleHash);
const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleHash });
console.log("    bloque", settleReceipt.blockNumber, "· gas", settleReceipt.gasUsed);

const devBalance = await publicClient.getBalance({ address: developerAddress });
console.log("\n✓ ciclo completo en GIWA Sepolia");
console.log("  desarrollador cobró:", formatEther(devBalance), "ETH");
console.log("  escrow restante    :", formatEther(await publicClient.getBalance({ address: deployment.address })), "ETH");
console.log("\nenlaces:");
console.log("  contrato  :", `${EXPLORER}/address/${deployment.address}`);
if (postHash) console.log("  postBounty:", `${EXPLORER}/tx/${postHash}`);
console.log("  settle    :", `${EXPLORER}/tx/${settleHash}`);

writeFileSync(
  new URL("../demo-tx.json", import.meta.url),
  JSON.stringify(
    {
      contract: deployment.address,
      bountyId: Number(bountyId),
      amount: formatEther(BOUNTY),
      agent: agent.address,
      developer: developerAddress,
      evidence,
      evidenceHash,
      postBountyTx: postHash,
      settleTx: settleHash,
      explorer: {
        contract: `${EXPLORER}/address/${deployment.address}`,
        postBounty: `${EXPLORER}/tx/${postHash}`,
        settle: `${EXPLORER}/tx/${settleHash}`,
      },
    },
    null,
    2,
  ),
);
