# Mergit — merge it, get paid

**Ship code. Get paid. Instantly.**

A trustless bounty protocol for [GIWA](https://giwa.io). Protocols post bounties with on-chain
escrow; an AI agent verifies the actual work — the diff, the tests, the merge, the deployment —
and releases payment in seconds. No committees, no forms, no waiting.

Submitted to **GASOK 2026**, Track 04 — AI / Web3.

---

## Live now

| | |
|---|---|
| 🌐 Site | **https://www.mergit.xyz** |
| 📄 Escrow contract | [`0xffcf206ce1474263aaa3336fb9c8bc3d632e5879`](https://sepolia-explorer.giwa.io/address/0xffcf206ce1474263aaa3336fb9c8bc3d632e5879) — **verified** on GIWA Sepolia |
| ⛓ Paid on merge | [`0x567a7c4b…bc44`](https://sepolia-explorer.giwa.io/tx/0x567a7c4b851b8b09f10d3aee2caea4883c6859a7aec625e2d1e750c7c161bc44) — [mergit-demo#2](https://github.com/odiseo159-beep/mergit-demo/pull/2) merged 00:49:36, paid 00:49:56 UTC |
| 🪪 Identity registry | [`0x79d44543d20c7c6653f6626687d67d2cd7f2af9c`](https://sepolia-explorer.giwa.io/address/0x79d44543d20c7c6653f6626687d67d2cd7f2af9c) — **verified**. One wallet, one GitHub login, one proof |
| ⏳ Escrow with a challenge window | [`0x48d506080abdbed11f1acbe40f799301d9612ad5`](https://sepolia-explorer.giwa.io/address/0x48d506080abdbed11f1acbe40f799301d9612ad5) — **verified**. Opt-in per bounty; zero seconds behaves like the escrow above |
| 🖥 From the browser | [mergit.xyz/post](https://www.mergit.xyz/post) to fund a bounty, [mergit.xyz/claim](https://www.mergit.xyz/claim) to claim a login, [mergit.xyz/p/odiseo159-beep](https://www.mergit.xyz/p/odiseo159-beep) for a builder's record |

On 19 September 2026 nobody ran a command: the merge woke the agent inside GitHub Actions, it
verified the pull request, and the escrow paid the developer **20 seconds later**. Every amount,
hash and transaction on the site is read from the chain.

## Add Mergit to your repository

One workflow file and one secret, and the merge pays.

**`.github/workflows/mergit.yml`** — the agent, on every merge:

```yaml
name: Mergit
on:
  push:
    branches: [main]
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
  checks: read
  statuses: read
  pull-requests: write
concurrency:
  group: mergit-settle
jobs:
  settle:
    runs-on: ubuntu-latest
    steps:
      - uses: odiseo159-beep/mergit@v1
        with:
          agent-key: ${{ secrets.MERGIT_AGENT_KEY }}
```

The secret `MERGIT_AGENT_KEY` holds the key of the bounty's verifier. Without it the action still
runs: it verifies and reports what it *would* pay, and signs nothing. That is the safest way to try
it.

Then write `Bounty: #N` in the body of a pull request. When it is merged and its CI is green, the
agent settles bounty `N` to the author's wallet and comments the receipt on the pull request.

### Where the author's wallet comes from

The agent asks the [on-chain registry](#live-now) first. A developer claims their GitHub login from
their own wallet and publishes a proof — a gist, or the README of their profile repository — and the
agent checks that proof against GitHub before it releases anything. **If a claimed proof is broken,
nothing is paid**, and the agent does not fall back to a file.

A repository can still ship an optional `mergit.json` for authors who have not claimed yet:

```json
{ "wallets": { "their-github-login": "0xTheirWallet" } }
```

The registry always wins over the file.

## Why this exists

Developer funding in crypto is slow (grant rounds take weeks or months), manual (committees read
applications, not code) and farmable (identity filters lose to sybils). A new chain lives or dies
by the builders it attracts — and paying them is still stuck in 2020.

Retroactive funding proved the model works; the bottleneck was always human verification. That is
the part an agent can do: read the diff, run the checks, confirm the merge and the deployment,
then release the money in minutes instead of a quarter.

## Repository layout

```
action.yml   The reusable GitHub Action: one step, and the merge pays
agent/       The verification agent: reads the pull request, decides, settles
contracts/   MergitEscrow.sol and MergitRegistry.sol + Hardhat tests and deploy scripts
site/        The site and its technical one-pager (static HTML/CSS/JS)
```

See [`contracts/README.md`](contracts/README.md) for the contract design, deployment details and
how to run the tests.

## Design principle

The escrow is deliberately **trust-minimised**: no owner, no pause, no upgradeability, an immutable
fee hard-capped in code. The verifier agent holds exactly one permission: naming the recipient of a
bounty it was assigned. It cannot change the amount, settle twice, settle past the deadline, or touch
any other bounty. Naming the recipient is the one thing still trusted today, and nothing in the contract
stops a verifier from naming an address it controls. Two pieces now narrow that gap: the payout
resolves through the on-chain registry, against a proof the agent re-checks on GitHub, and a bounty
can carry a challenge window during which the funder may object once. A funding protocol
that asks people to trust its operator has not solved the problem it claims to solve.

## Roadmap

| Phase | Status |
|---|---|
| **1 — Concept & screening** | ✅ Escrow deployed and verified on GIWA Sepolia; full lifecycle settled on-chain |
| **2 — Testnet MVP** | 🔄 Agent v1 runs on every merge, as a reusable action. Developers claim their GitHub login on-chain with a proof the agent checks. An escrow with an opt-in challenge window is deployed, and bounties can be funded and logins claimed from the browser. Next: a GitHub App, and repositories that are not ours |
| **3 — Mainnet** | Stablecoin payouts, first partner protocols, fee switch on |
| **Demoday @ KBW** | Merge a PR live on stage, watch the payment land |
| **Beyond** | Automated retroactive funding pools and a builder reputation graph |

## Author

Daniel Bryan Francia Asencio — solo founder.
[GitHub](https://github.com/odiseo159-beep) · [X](https://x.com/Thecomodor159) · SimplifAI S.A.C., Lima, Peru

## License

MIT
