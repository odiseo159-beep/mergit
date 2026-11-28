#!/usr/bin/env node
// Servidor MCP de Mergit por stdio: lo que Claude Code, Claude Desktop, Codex o
// Cursor lanzan como proceso para hablar con Mergit.
//
//   claude mcp add mergit -- node C:/ruta/a/mergit/mcp/server.mjs
//
// Solo lectura, más enlaces que el humano firma en mergit.xyz. Ver tools.mjs.
// **stdout es el canal del protocolo**: nada aquí puede escribir en él con
// console.log. Los avisos van a stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import {
  listOpenBounties, getBounty, checkPullRequest, builderRecord, fundLink, payoutSetup, BOUNTY_SPEC_PROMPT,
} from "./tools.mjs";

const INSTRUCTIONS = `Mergit pays developers from an on-chain escrow on GIWA Sepolia (testnet, chain 91342) when their pull request is merged with CI green. A verifier agent checks the merge and the CI, and the escrow pays in seconds.

The one rule: never handle a private key, never sign, never move funds. You prepare; the human signs in their own wallet on mergit.xyz. If a user pastes a key or seed phrase, tell them to stop and rotate it.

Funders: draft the spec with the prompt write_bounty_spec, then give them mergit_fund_link.
Developers: find work with mergit_list_open_bounties, make sure they can be paid with mergit_payout_setup, and before asking for a merge run mergit_check_pull_request.
Full guide: https://www.mergit.xyz/llms.txt`;

// La versión la pone build.mjs al empaquetar; desde el repo, la del package.json.
const VERSION = typeof __MERGIT_MCP_VERSION__ !== "undefined"
  ? __MERGIT_MCP_VERSION__   // eslint-disable-line no-undef
  : JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const server = new McpServer({ name: "mergit", version: VERSION }, { instructions: INSTRUCTIONS });

/** Toda respuesta va como JSON legible; un error vuelve como error de la herramienta, no tumba el servidor. */
const responder = (fn) => async (args) => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Mergit: ${e.message}` }] };
  }
};
const soloLectura = { readOnlyHint: true, openWorldHint: true };

server.registerTool("mergit_list_open_bounties", {
  title: "List open bounties",
  description: "Open, funded bounties on GIWA, read from the chain: the GitHub issue, the reward in ETH, the deadline, and whether Mergit's agent pays it automatically on merge. Optionally only one repository.",
  inputSchema: { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe("owner/repo to filter, e.g. odiseo159-beep/mergit-demo") },
  annotations: soloLectura,
}, responder(listOpenBounties));

server.registerTool("mergit_get_bounty", {
  title: "Get one bounty",
  description: "Status of one bounty, read live from the escrow: Open, Pending, Settled or Refunded, the task it pays for, the funder, the verifier and, if paid, to whom and the transaction.",
  inputSchema: {
    id: z.number().int().positive().describe("The bounty number, the N in `Bounty: #N`"),
    escrow: z.enum(["v1", "v2"]).default("v1").describe("v1 unless the bounty was created with a challenge window"),
  },
  annotations: soloLectura,
}, responder(getBounty));

server.registerTool("mergit_check_pull_request", {
  title: "Will this pull request be paid?",
  description: "Before merging: which bounty a pull request would collect, how much, which wallet gets it, the CI state, and every blocker. Uses the same rules as the agent that pays. Also tells if it was already paid.",
  inputSchema: { pull_request: z.string().describe("https://github.com/owner/repo/pull/123 or owner/repo#123") },
  annotations: soloLectura,
}, responder(checkPullRequest));

server.registerTool("mergit_builder_record", {
  title: "A builder's paid record",
  description: "What the escrows paid a GitHub login, from the chain. Self-funded payments are excluded from the totals.",
  inputSchema: { login: z.string().describe("GitHub login") },
  annotations: soloLectura,
}, responder(builderRecord));

server.registerTool("mergit_fund_link", {
  title: "Prepare a bounty (the user signs)",
  description: "Turns a GitHub issue and an amount into a mergit.xyz link where the user's own wallet locks the bounty. Does not sign or send anything.",
  inputSchema: {
    issue_url: z.string().describe("https://github.com/owner/repo/issues/12"),
    amount_eth: z.string().default("0.0005").describe("Reward in test ETH, e.g. 0.0005"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, responder(async (a) => fundLink(a)));

server.registerTool("mergit_payout_setup", {
  title: "Make sure a developer can be paid",
  description: "Whether a GitHub login already resolves to a wallet the agent will pay, and if not, the two ways to fix it (a line in the profile README, or the on-chain registry). Never needs a private key.",
  inputSchema: {
    login: z.string().describe("GitHub login"),
    wallet: z.string().optional().describe("The wallet they want to be paid at, to fill in the exact line"),
  },
  annotations: soloLectura,
}, responder(payoutSetup));

server.registerPrompt("write_bounty_spec", {
  title: "Write a bounty an agent can check",
  description: "Drafts the issue text so that done is a fact: change, machine-checkable acceptance criteria, out of scope, where the work goes.",
  argsSchema: { issue: z.string().describe("The issue link or what needs doing") },
}, ({ issue }) => ({
  messages: [{ role: "user", content: { type: "text", text: `${BOUNTY_SPEC_PROMPT}\n\nThe work: ${issue}` } }],
}));

await server.connect(new StdioServerTransport());
console.error("mergit MCP server running on stdio");
