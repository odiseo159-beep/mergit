# Mergit for coding agents

You are probably reading this because you are an AI agent working inside someone's repository, and
something in that repository points here.

Mergit pays a developer from an on-chain escrow the moment their pull request is merged and CI is
green. A verifier agent reads the pull request through the GitHub API, checks two facts, and the
escrow releases the money. No form, no committee.

Everything below runs on **GIWA Sepolia**, a testnet. Chain id `91342`.

---

## The one rule you must not break

**Never handle a private key. Never sign a transaction. Never move funds.**

You prepare. The human signs.

Every action in this document that moves money ends the same way: you produce the parameters and
hand your user a link to a page where **their own wallet** signs. If you find yourself about to read
a `.env`, a `*.secret.json`, or a key pasted into chat, stop and say so.

This is not a style preference. Mergit's entire argument is that nobody has to trust an operator. An
agent holding a key is an operator.

---

## Task 1 — your user wants to pay someone for work

This is the most useful thing you can do with Mergit, and it fits a moment that happens constantly:
your user hits something out of scope. A migration they do not have time for. A bug in a dependency.
A test suite nobody wants to write.

Instead of leaving a `TODO` that lives forever, offer to turn it into a funded bounty.

**What you do:**

1. Write the bounty specification. See *Writing a bounty an agent can check* below. This is the part
   you are actually good at, and it is the part humans skip.
2. Propose an amount. Say plainly that you are guessing, and let the user set it.
3. Send them to **https://www.mergit.xyz/post**. That page builds the transaction and their wallet
   signs it. The page never holds funds and never stores anything.
4. The page returns a line like `Bounty: #12`. Put that line in the body of the issue or the pull
   request that will claim it.

**What you do not do:** call `postBounty` yourself, generate a wallet, or ask for a key.

## Task 2 — connect this repository so a merge pays

Two files, and nothing else changes about how people work.

**`.github/workflows/mergit.yml`:**

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
      - uses: odiseo159-beep/mergit@v1.5
        with:
          agent-key: ${{ secrets.MERGIT_AGENT_KEY }}
```

All four permissions are required. Without `checks: read` and `statuses: read`, GitHub answers 403
and the agent cannot see whether CI passed.

**The secret `MERGIT_AGENT_KEY`** holds the verifier's key. Your user adds it in the repository
settings themselves. You do not ask for it, you do not read it, you do not echo it.

**Suggest the rehearsal first.** Without the secret, the action still runs: it verifies the pull
request and reports what it *would* pay, and signs nothing. That is the honest way to try this on a
repository that matters.

## Task 3 — your user wants to be paid for their own work

The escrow pays a wallet, so the author's GitHub login has to resolve to one.

Send them to **https://www.mergit.xyz/register**. They register their login from their own wallet and
publish a proof: a gist, or a line in the README of their profile repository. The verifier
re-checks that proof against GitHub before it releases anything, and **if the proof is broken,
nothing is paid**. It does not silently fall back to a file.

A repository can ship an optional fallback for contributors who have not claimed yet:

```json
{ "wallets": { "their-github-login": "0xTheirWallet" } }
```

in `mergit.json` at the root. The on-chain registry always wins over the file.

## Task 3b — your user wants to take an open bounty

Open bounties are GitHub issues labelled `bounty`. Ask GitHub for them; there is no index to keep
in sync and nothing to ask us for.

```
GET https://api.github.com/search/issues?q=repo:odiseo159-beep/mergit+label:bounty+state:open
```

Every one of them has the same shape, so you can read it without guessing:

- **What done looks like** — the acceptance criteria. If your change does not satisfy all of them,
  it will not be merged, and nothing that is not merged is paid.
- **Where it goes** — the paths you may touch. A pull request that writes outside them is out of
  scope for that bounty.
- **Bounty: #N** — the number on chain. **Copy that line into your pull request description.** The
  agent reads it to know which bounty to settle. A pull request without it is merged like any
  other and pays nobody.

Then, in order:

1. Make sure the author can be paid. One line naming Mergit and their address in the README of
   their GitHub profile repository is enough, and costs nothing. See Task 3.
2. Open the pull request, with `Bounty: #N` in its description.
3. Wait for CI. The agent refuses to pay without a green check on the pull request's head commit:
   the absence of CI is not CI passing.
4. A maintainer merges it. The agent settles on its own and comments the receipt underneath, with
   the amount, the evidence hash and the transaction.

**One bounty, one payment.** The first pull request merged against a bounty takes it. If two
arrive, the second is still a pull request on its merits, but the money is gone.

**Do not touch `agent/` or `action.yml`.** Those run with the key that signs payments, so changes
there are not bounty work.

## Task 4 — read the chain, check a claim, check a record

All of this is public and needs no key.

| | |
|---|---|
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |
| Escrow | `0xffcf206ce1474263aaa3336fb9c8bc3d632e5879` |
| Escrow with a challenge window | `0x48d506080abdbed11f1acbe40f799301d9612ad5` |
| Identity registry | `0x79d44543d20c7c6653f6626687d67d2cd7f2af9c` |

All three are source-verified on the explorer, so you can read their ABIs there.

**To list what actually happened**, do not call `eth_getLogs` against the public RPC: it caps the
range at 10,000 blocks and you will miss everything older. Use the explorer's API instead, which
returns decoded events and allows cross-origin requests:

```
GET https://sepolia-explorer.giwa.io/api/v2/addresses/{address}/logs
```

The events you want are `BountyPosted` and `BountySettled`.

**To see a builder's record**, read `https://www.mergit.xyz/p/<github-login>`. It resolves the claim
from the registry, re-checks the proof against GitHub on every load, and lists what the escrows paid
that wallet. Payments where the funder and the recipient are the same wallet are marked as
self-funded and excluded from the totals. If you are assessing a contributor, that flag is the one
to read first.

---

## Writing a bounty an agent can check

Most bounties are written as a wish. That is why paying for them needs a committee.

Write yours so that "done" is a fact, not an opinion. When you draft a bounty specification, produce
these four parts:

**1. The change, in one sentence.** What must be true afterwards that is not true now.

**2. Acceptance criteria that a machine can evaluate.** Not "clean code" or "good performance".
Things like:

- `npm test` passes, including a new test named `x`
- the function `y` returns `z` for input `w`
- the endpoint `/health` answers 200
- no new dependency is added to `package.json`

**3. What is out of scope.** The single most common reason a bounty ends in an argument is that the
contributor solved a bigger problem than the funder wanted to pay for.

**4. Where the work goes.** The repository, the branch it targets, and whether an issue already
exists.

Write these criteria even when the amount is small. They cost you one minute and they are what makes
the difference between a bounty that settles and a bounty that becomes a negotiation.

---

## What Mergit does not do

Be accurate about this with your user. Overselling it is worse than not mentioning it.

**It does not judge quality.** The verifier asks two questions: was the pull request merged, and is
CI green on the head commit. It does not read the code for correctness, elegance or impact. The
maintainers already made that judgement when they clicked merge.

**It does not find work for you.** There is no marketplace. A bounty exists because someone funded
it and pointed at it.

**It is on a testnet.** The contracts are deployed and verified on GIWA Sepolia. Real value is not
moving yet. Say so when you explain this to someone.

**It cannot fund what nobody posted.** Most of the work that keeps open source alive is invisible
until later. Retroactive funding exists for that problem, and Mergit does not solve it.

---

## If something is unclear

The code is public and small: `agent/` holds the verifier, `contracts/` holds the three contracts
and their tests, `action.yml` is the reusable step. Read those rather than guessing.

Repository: https://github.com/odiseo159-beep/mergit
Site: https://www.mergit.xyz
