// La prueba en vivo del camino que arregla la v4: un pago aprobado a una dirección
// que rechaza ETH se acredita, no se atasca, y después se retira.
//
//   node scripts/credit-test-v4.mjs desplegar          simula el despliegue de RechazaEther
//   node scripts/credit-test-v4.mjs desplegar --send   lo despliega (firma la wallet 0x23E8)
//   node scripts/credit-test-v4.mjs estado             qué tiene acreditado, sin firmar nada
//   node scripts/credit-test-v4.mjs retirar            simula el retiro
//   node scripts/credit-test-v4.mjs retirar --send     retira a 0x23E8 (firma la misma wallet)
//
// El orden completo (25-nov-2026, sugerido por Aegis):
//   1. desplegar --send
//   2. node scripts/post-v4-test.mjs --send               bounty nuevo en la v4, 180 s
//   3. en agent/: settle.mjs con --developer <RechazaEther>, en la v4
//   4. a los 3 minutos, el mismo comando: finalize → PaymentCredited
//   5. retirar --send                                     → PaymentWithdrawn
//
// Despliega y retira la wallet `developer` de WALLETS.secret.json (0x23E8…7686), que
// queda como dueña de RechazaEther: es la única que puede sacar lo acreditado.
import { createPublicClient, createWalletClient, http, formatEther, encodeDeployData, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const { address: ESCROW, contract: CONTRATO } = JSON.parse(
  readFileSync(new URL("../deployment-v4.json", import.meta.url), "utf8"),
);
if (CONTRATO !== "MergitEscrowV4") throw new Error("deployment-v4.json no es de la v4");
const DUENO = "0x23E8541dA96158d342477D694274E27639807686";
const REGISTRO = new URL("../deployment-rechaza.json", import.meta.url);
const EXPLORER = "https://sepolia-explorer.giwa.io";

const giwaSepolia = {
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
};
const publicClient = createPublicClient({ chain: giwaSepolia, transport: http() });
const artefacto = (nombre) => JSON.parse(
  readFileSync(new URL(`../artifacts/contracts/${nombre}.sol/${nombre}.json`, import.meta.url), "utf8"),
);
const rechaza = artefacto("RechazaEther");
const escrowAbi = artefacto("MergitEscrowV4").abi;

const [paso] = process.argv.slice(2);
const send = process.argv.includes("--send");

function cuenta() {
  const secrets = JSON.parse(readFileSync(new URL("../../WALLETS.secret.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(secrets.developer.privateKey);
  if (account.address !== DUENO) throw new Error("la clave developer no corresponde a 0x23E8…7686");
  return account;
}
function direccion() {
  if (!existsSync(REGISTRO)) throw new Error("todavía no hay RechazaEther: corre primero `desplegar --send`");
  return JSON.parse(readFileSync(REGISTRO, "utf8")).address;
}

if (paso === "desplegar") {
  const data = encodeDeployData({ abi: rechaza.abi, bytecode: rechaza.bytecode, args: [ESCROW] });
  console.log("RechazaEther · un developer que no recibe ETH");
  console.log("  escrow v4 :", ESCROW);
  console.log("  dueño     :", DUENO);
  console.log("  saldo     :", formatEther(await publicClient.getBalance({ address: DUENO })), "ETH de prueba");
  const gas = await publicClient.estimateGas({ account: DUENO, data });
  console.log("  gas       :", String(gas));
  if (!send) { console.log("\nLa simulación pasa. Nada se firmó. Vuelve a correrlo con --send."); process.exit(0); }

  const wallet = createWalletClient({ account: cuenta(), chain: giwaSepolia, transport: http() });
  const hash = await wallet.deployContract({ abi: rechaza.abi, bytecode: rechaza.bytecode, args: [ESCROW] });
  console.log("\ntx enviada:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  writeFileSync(REGISTRO, JSON.stringify({
    network: "giwa-sepolia", chainId: 91342, contract: "RechazaEther", address, owner: DUENO,
    constructorArgs: [ESCROW], txHash: hash, blockNumber: Number(receipt.blockNumber),
    explorer: `${EXPLORER}/address/${address}`, deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`✓ RechazaEther en ${address} (bloque ${receipt.blockNumber})`);
  console.log(`  ${EXPLORER}/address/${address}`);
  console.log("\nSiguiente: node scripts/post-v4-test.mjs --send");
  console.log(`Y en agent/, el settle con --developer ${address}`);
} else if (paso === "estado") {
  const a = direccion();
  const owed = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "owed", args: [a] });
  console.log("RechazaEther :", a);
  console.log("acreditado   :", formatEther(owed), "ETH en la v4");
  const desde = BigInt(JSON.parse(readFileSync(REGISTRO, "utf8")).blockNumber);
  for (const [nombre, firma] of [
    ["PaymentCredited", "event PaymentCredited(uint256 indexed bountyId, address indexed to, uint256 amount)"],
    ["PaymentWithdrawn", "event PaymentWithdrawn(address indexed owner, address indexed to, uint256 amount)"],
  ]) {
    const logs = await publicClient.getLogs({ address: ESCROW, event: parseAbiItem(firma), fromBlock: desde }).catch(() => []);
    for (const l of logs.filter((l) => [l.args.to, l.args.owner].some((x) => x?.toLowerCase() === a.toLowerCase()))) {
      console.log(`${nombre.padEnd(17)}: ${formatEther(l.args.amount)} ETH · ${EXPLORER}/tx/${l.transactionHash}`);
    }
  }
} else if (paso === "retirar") {
  const a = direccion();
  const owed = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: "owed", args: [a] });
  console.log("RechazaEther :", a);
  console.log("acreditado   :", formatEther(owed), "ETH");
  console.log("destino      :", DUENO);
  if (owed === 0n) { console.log("\nNo hay nada acreditado todavía: falta el finalize."); process.exit(1); }
  await publicClient.simulateContract({ account: DUENO, address: a, abi: rechaza.abi, functionName: "retirar", args: [DUENO] });
  if (!send) { console.log("\nLa simulación pasa. Nada se firmó. Vuelve a correrlo con --send."); process.exit(0); }

  const wallet = createWalletClient({ account: cuenta(), chain: giwaSepolia, transport: http() });
  const hash = await wallet.writeContract({ address: a, abi: rechaza.abi, functionName: "retirar", args: [DUENO] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(receipt.status === "success" ? "\n✓ retirado" : "\n✗ revertida");
  console.log(`  ${EXPLORER}/tx/${hash}`);
} else {
  console.log("Uso: node scripts/credit-test-v4.mjs desplegar|estado|retirar [--send]");
  process.exit(1);
}
