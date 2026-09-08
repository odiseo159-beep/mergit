# Mergit verification agent

Reads a real pull request, decides whether the work exists, and releases the
escrow on GIWA when it does.

```bash
npm install

# Does this work deserve payment?
node verify.mjs https://github.com/owner/repo/pull/123

# Verify, then settle bounty #2 on GIWA Sepolia (dry run by default)
node settle.mjs --bounty 2 --pr owner/repo#123
node settle.mjs --bounty 2 --pr owner/repo#123 --developer 0x... --send

# Open a bounty to settle against (the funder's side of the loop)
node post-bounty.mjs --uri "github.com/owner/repo/issues/1" --amount 0.0005 --send
```

`chain.mjs` holds the chain definition, the escrow ABI and the shared helpers.
`verify.mjs` is both a CLI and a library: `settle.mjs` imports its verdict.

`GITHUB_TOKEN` is optional: without it the agent reads public repositories at
60 requests per hour. `MERGIT_ESCROW` overrides the contract address, which
otherwise comes from `../contracts/deployment.json`.

## What "verified" means today

A pull request passes when it is **merged** and its **CI is green**. Both
conditions, no exceptions.

Three decisions worth knowing about:

- **CI is read on the pull request's head commit**, not on the merge commit.
  That is where the tests for the submitted work actually ran. The merge commit
  stays in the evidence as proof of the merge.
- **No CI is not the same as passing CI.** If a repository reports no checks for
  the commit, the agent returns a null signal and refuses to pay, rather than
  assuming everything is fine.
- **`neutral` and `skipped` checks do not block payment.** They mean "does not
  apply", not "failed". Treating them as failures would leave good work unpaid.

Both of GitHub's CI mechanisms are read, modern check runs and legacy commit
statuses, because repositories use one, the other, or both.

## The evidence hash

Every verdict produces a canonical JSON record of what the agent looked at
(repository, pull request, author, head SHA, merge commit, merge time, base
branch, and every check with its conclusion) hashed with keccak256. The same
pull request always produces the same hash, on any machine.

That hash is what `MergitEscrow` records in the `BountySettled` event, so anyone
can recompute it later and audit why a payment happened.

## Settling

`settle.mjs` refuses to sign unless every condition holds: the work verifies,
the bounty exists and is still `Open`, its deadline has not passed, and this
agent is the bounty's designated verifier. It then simulates the call against
the chain and only signs afterwards, and only when `--send` is present.

The verifier can choose who gets paid. By the contract's design it can never
redirect the funds, change the amount, or pay itself.
