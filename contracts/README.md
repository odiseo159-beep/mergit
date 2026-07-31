# MergitEscrow — GIWA Sepolia

Bounty escrow contract powering [Mergit](https://mergit-nine.vercel.app), submitted to the
GASOK 2026 program (Track 04 — AI / Web3).

A funder locks ETH against a task and names a **verifier** — the Mergit AI agent. When the
agent confirms the work actually exists (PR merged, CI green, contract deployed), it releases
the escrow to the developer and records a hash of the evidence it judged. If nobody delivers
before the deadline, the funder reclaims the funds.

## Deployment

| | |
|---|---|
| Network | GIWA Sepolia (chain ID `91342`) |
| Contract | [`0xffcf206ce1474263aaa3336fb9c8bc3d632e5879`](https://sepolia-explorer.giwa.io/address/0xffcf206ce1474263aaa3336fb9c8bc3d632e5879) |
| Status | **Verified** on the GIWA block explorer |
| Compiler | solc 0.8.24, optimizer on (200 runs), evm target `shanghai` |
| Constructor | `feeBps = 150` (1.5%), `feeRecipient = 0x28Df…852b` |

### A full lifecycle already ran on-chain

| Step | Transaction |
|---|---|
| Bounty #1 posted (0.0005 ETH locked) | [`0x50b935b6…68c2`](https://sepolia-explorer.giwa.io/tx/0x50b935b6ed7a724948437db75a776e84692ded1cce841ddbe07c1b92570568c2) |
| Settled to developer by the agent | [`0x43bee6f7…717a`](https://sepolia-explorer.giwa.io/tx/0x43bee6f7cdc295b107998aaff741e71c3326c4acb2c344971b1e9f860d0b717a) |

The developer received `0.0004925 ETH`, the protocol took `0.0000075 ETH` (1.5%), and the
`BountySettled` event carries the evidence hash
`0x667f6a133c246fa92b52490f90ceb58449be34ce58d48eec3d692361c29ff6d8` —
`keccak256("pr:odiseo/giwa-oracle#7|commit:9f2c1ab|ci:34-passed|merged:true")`.

## Design decisions

The contract is deliberately **trust-minimised** — this is the core of Mergit's argument:

- **No owner, no pause, no upgradeability.** Nobody, including the author, can touch funds
  held for someone else.
- **The verifier's power is bounded.** It can only choose *who* gets paid — never redirect
  funds to itself, change the amount, or settle after the deadline.
- **The fee is immutable** and hard-capped at 5% in code (`MAX_FEE_BPS`).
- **Evidence is auditable.** Every payout emits the hash of what the agent evaluated.
- Checks-effects-interactions ordering plus a reentrancy guard on both value-moving paths.

## Development

```bash
npm install
npx hardhat compile
npx hardhat test          # 14 tests
```

Deploy and verify (requires `../WALLETS.secret.json`, git-ignored):

```bash
node scripts/deploy.mjs
npx hardhat verify --network giwaSepolia <address> 150 <feeRecipient>
```

Run the demo lifecycle against the live contract:

```bash
node scripts/demo-tx.mjs             # posts a bounty and settles it
node scripts/demo-tx.mjs --settle 1  # settles an already-posted bounty
node scripts/balance.mjs             # deployer balance on GIWA Sepolia
```

> Note: the GIWA RPC can serve slightly stale state immediately after a transaction is mined.
> `demo-tx.mjs` therefore reads the new bounty id from the `BountyPosted` event in the
> receipt rather than from a follow-up `nextBountyId` call.

## Roadmap

This is the Phase 1 foundation. Phase 2 (GASOK testnet milestone) adds the GitHub App
integration and the verification agent running against real repositories; Phase 3 moves to
GIWA mainnet with stablecoin payouts.
