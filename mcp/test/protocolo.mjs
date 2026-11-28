// Prueba de humo por el protocolo real: lanza server.mjs como lo haría Claude o
// Codex, lista herramientas y llama dos. Usa la red (GIWA y GitHub).
//   node test/protocolo.mjs        el código del repo
//   node test/protocolo.mjs dist   el paquete que va a npm
//   node test/protocolo.mjs <ruta> cualquier archivo, p. ej. el paquete ya instalado
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const arg = process.argv[2];
const archivo = arg === "dist" ? fileURLToPath(new URL("../dist/mergit-mcp.mjs", import.meta.url))
  : arg ? arg
  : fileURLToPath(new URL("../server.mjs", import.meta.url));
console.log("probando", archivo);
const transport = new StdioClientTransport({ command: process.execPath, args: [archivo] });
const client = new Client({ name: "prueba", version: "0" });
await client.connect(transport);
console.log("instrucciones:", (client.getInstructions() ?? "").slice(0, 80), "…");
const { tools } = await client.listTools();
console.log("herramientas:", tools.map((t) => t.name).join(", "));
const { prompts } = await client.listPrompts();
console.log("prompts:", prompts.map((p) => p.name).join(", "));
const r = await client.callTool({ name: "mergit_get_bounty", arguments: { id: 35 } });
console.log("get_bounty 35 →", JSON.parse(r.content[0].text).status);
const e = await client.callTool({ name: "mergit_fund_link", arguments: { issue_url: "no es un issue" } });
console.log("fund_link malo → isError:", e.isError, "|", e.content[0].text);
// La wallet tiene que salir del registro on-chain: en el paquete de npm no viaja
// contracts/registry.json, y sin la dirección fija en tools.mjs saldría de otra fuente.
const p = JSON.parse((await client.callTool({ name: "mergit_payout_setup", arguments: { login: "gmlokie" } })).content[0].text);
console.log("payout_setup gmlokie →", p.current.source, p.current.wallet);
if (p.current.source !== "registry") { console.error("FALLA: la wallet no salió del registro"); process.exitCode = 1; }
await client.close();
