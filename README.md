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

On 19 September 2026 nobody ran a command: the merge woke the agent inside GitHub Actions, it
verified the pull request, and the escrow paid the developer **20 seconds later**. Every amount,
hash and transaction on the site is read from the chain.

## Add Mergit to your repository

Two files, and the merge pays.

**1. `mergit.json`** — who gets paid, by GitHub login:

```json
{ "wallets": { "your-github-login": "0xYourWallet" } }
```

**2. `.github/workflows/mergit.yml`** — the agent, on every merge:

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

Then write `Bounty: #N` in the body of a pull request. When it is merged and its CI is green, the
agent settles bounty `N` to the author's registered wallet and comments the receipt on the pull
request.

Without `agent-key` the action still runs: it verifies and reports what it *would* pay, and signs
nothing. That is the safest way to try it.

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
stops a verifier from naming an address it controls; binding the payout to the pull request author's
registered wallet and adding a challenge window are what remove that trust next. A funding protocol
that asks people to trust its operator has not solved the problem it claims to solve.

## Roadmap

| Phase | Status |
|---|---|
| **1 — Concept & screening** | ✅ Escrow deployed and verified on GIWA Sepolia; full lifecycle settled on-chain |
| **2 — Testnet MVP** | 🔄 Agent v1 runs on every merge, as a reusable action; developers claim their GitHub login on-chain with a proof the agent checks. Next: challenge window, posting bounties from the browser |
| **3 — Mainnet** | Stablecoin payouts, first partner protocols, fee switch on |
| **Demoday @ KBW** | Merge a PR live on stage, watch the payment land |
| **Beyond** | Automated retroactive funding pools and a builder reputation graph |

## Author

Daniel Bryan Francia Asencio — solo founder.
[GitHub](https://github.com/odiseo159-beep) · [X](https://x.com/Thecomodor159) · SimplifAI S.A.C., Lima, Peru

## License

MIT
