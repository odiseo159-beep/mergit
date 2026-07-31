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
| 🌐 Product walkthrough | **https://mergit-nine.vercel.app** |
| 📄 Escrow contract | [`0xffcf206ce1474263aaa3336fb9c8bc3d632e5879`](https://sepolia-explorer.giwa.io/address/0xffcf206ce1474263aaa3336fb9c8bc3d632e5879) — **verified** on GIWA Sepolia |
| ⛓ Bounty settled on-chain | [`0x2e8a04f7…b9d7`](https://sepolia-explorer.giwa.io/tx/0x2e8a04f7393c4c4457acfc5aba5f06091893a9105ef663531ae43b22c3a3b9d7) |

The contract is **really deployed** and a complete bounty lifecycle has already been executed on
GIWA Sepolia: funds locked in escrow, then released to the developer by the verifier, with a hash
of the evidence recorded in the event. The interactive demo on the website is *simulated* and
labelled as such — it illustrates the agent loop that Phase 2 will run against real repositories.

## Why this exists

Developer funding in crypto is slow (grant rounds take weeks or months), manual (committees read
applications, not code) and farmable (identity filters lose to sybils). A new chain lives or dies
by the builders it attracts — and paying them is still stuck in 2020.

Retroactive funding proved the model works; the bottleneck was always human verification. That is
the part an agent can do: read the diff, run the checks, confirm the merge and the deployment,
then release the money in minutes instead of a quarter.

## Repository layout

```
contracts/   MergitEscrow.sol + Hardhat tests, deploy and verify scripts
site/        Product page and interactive demo (static HTML/CSS/JS)
```

See [`contracts/README.md`](contracts/README.md) for the contract design, deployment details and
how to run the tests.

## Design principle

The escrow is deliberately **trust-minimised**: no owner, no pause, no upgradeability, an immutable
fee hard-capped in code. The verifier agent can only choose *who* gets paid — never redirect funds
to itself, change the amount, or settle past the deadline. A funding protocol that asks people to
trust its operator has not solved the problem it claims to solve.

## Roadmap

| Phase | Status |
|---|---|
| **1 — Concept & screening** | ✅ Escrow deployed and verified on GIWA Sepolia; lifecycle settled on-chain |
| **2 — Testnet MVP** | GitHub App integration, verification agent v1 against real repositories |
| **3 — Mainnet** | Stablecoin payouts, first partner protocols, fee switch on |
| **Demoday @ KBW** | Merge a PR live on stage, watch the payment land |
| **Beyond** | Automated retroactive funding pools and a builder reputation graph |

## Author

Daniel Bryan Francia Asencio — solo founder.
[GitHub](https://github.com/odiseo159-beep) · [X](https://x.com/Thecomodor159) · SimplifAI S.A.C., Lima, Peru

## License

MIT
