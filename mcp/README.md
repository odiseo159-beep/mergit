# Mergit MCP server

Mergit as tools for Claude Code, Claude Desktop, Codex, Cursor or any MCP client. Ask your AI
"which bounties are open on GIWA?" or "will merging this PR pay me?" and it answers from the chain.

**Read-only.** It holds no key, signs nothing and moves no funds. When money has to move, it returns
a mergit.xyz link where the user's own wallet signs. `test/sin-claves.test.mjs` fails if the server's
code names a key or a signing call, or imports the agent's signing scripts.

## Tools

| Tool | What it answers |
|---|---|
| `mergit_list_open_bounties` | Open, funded bounties on GIWA: the issue, the reward, the deadline, and whether Mergit's agent pays it on merge |
| `mergit_get_bounty` | One bounty, live from the escrow: Open, Pending, Settled or Refunded, and to whom |
| `mergit_check_pull_request` | Would merging this pay, how much, to which wallet, and every blocker. Same rules as the paying agent |
| `mergit_builder_record` | What the escrows paid a GitHub login, self-funded payments excluded |
| `mergit_fund_link` | A link where the user's wallet locks a bounty for a GitHub issue |
| `mergit_payout_setup` | Whether a login can be paid, and the two ways to fix it if not |

Prompt: `write_bounty_spec`, to draft an issue whose "done" a machine can check.

## Install

Node 20 or newer. Nothing to clone: `npx` fetches the package.

**Claude Code**

```
claude mcp add mergit -- npx -y mergit-mcp
```

On Windows, if the client cannot find `npx`, wrap it: `claude mcp add mergit -- cmd /c npx -y mergit-mcp`.

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.mergit]
command = "npx"
args = ["-y", "mergit-mcp"]
```

**Claude Desktop, Cursor** (`mcpServers` in their JSON config)

```json
{ "mcpServers": { "mergit": { "command": "npx", "args": ["-y", "mergit-mcp"] } } }
```

Optional: `GITHUB_TOKEN` in the server's environment raises GitHub's limit from 60 to 5,000
requests an hour. A token that only reads public repositories is enough.

**From the source**, to run what is in the repository instead of the published package:

```
git clone https://github.com/odiseo159-beep/mergit
cd mergit/agent && npm ci && cd ../mcp && npm ci
claude mcp add mergit -- node /absolute/path/to/mergit/mcp/server.mjs
```

## How it decides

The decisions are imported from `agent/`, the code that pays, not rewritten: which bounty a pull
request collects (`Bounty: #N`, or the issue it closes), which wallet gets it (on-chain registry,
then the profile README, then `mergit.json`), and what counts as CI. A tool that says "this will pay"
while the agent does not would be worse than no tool.

Chain: GIWA Sepolia, a testnet. Test ETH, real on-chain record.

## Tests

```
npm test                       # offline: amounts, links, filters, and the no-keys rule
node test/protocolo.mjs        # over the real protocol, against the chain and GitHub
node test/protocolo.mjs dist   # the same, against the bundle that goes to npm
```

Releasing, and when a release is required: [RELEASING.md](RELEASING.md).
