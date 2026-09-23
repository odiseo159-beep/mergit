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
`verify.mjs` and `settle.mjs` are both CLIs and libraries.

## Paid on merge: `on-event.mjs`

Runs inside GitHub Actions in the repository that posts bounties, so a merge pays
without anyone typing a command. It reacts to two events, in whichever order they
arrive: a push to the default branch (something was merged) and a completed `CI`
workflow (tests finished). Each run re-verifies from scratch and lets `verify.mjs`
decide. If the pull request is not merged yet or its CI is still running, it exits
quietly and the next event tries again. If the bounty is already settled, it exits
quietly too.

- **Which bounty:** a line `Bounty: #N` in the pull request description.
- **Who gets paid:** the author's wallet as registered in `mergit.json` on the
  default branch. The agent does not pick the recipient.
- **When:** only when `MERGIT_AGENT_KEY` is set as a repository secret. Without it,
  every run is a dry run that reports what it would pay.

On payment it comments on the pull request with the amount, the evidence hash and
the transaction. See `odiseo159-beep/mergit-demo` for a working setup.

Any repository plugs it in with one step, through the action at the root of this
repository:

```yaml
      - uses: odiseo159-beep/mergit@v1
        with:
          agent-key: ${{ secrets.MERGIT_AGENT_KEY }}
```

The workflow needs four permissions: `contents: read` to read the repository,
`checks: read` and `statuses: read` because CI reports through both mechanisms, and
`pull-requests: write` to comment the receipt. Miss either CI permission and GitHub
answers 403, where the agent cannot tell green from missing.

The action installs the agent and runs `on-event.mjs` with the right environment.
Its `pull-request` input re-checks a single pull request by number, which is what a
manual re-run needs; `MERGIT_PR` does the same when the agent runs on its own.

`GITHUB_TOKEN` is optional: without it the agent reads public repositories at
60 requests per hour. `MERGIT_ESCROW` overrides the contract address, which
otherwise comes from `../contracts/deployment.json`.

## Who gets paid: `registry.mjs` and `claim.mjs`

The recipient used to come from `mergit.json`, a file in the repository. That works,
but it means the funder's repository decides who a developer is. The registry moves
that claim on-chain, where it belongs to the developer:

```
node claim.mjs --login <github> --proof https://gist.github.com/<github>/<id> --send
node claim.mjs --who <github>
```

`MergitRegistry` stores the claim, its date and a pointer to the proof. It cannot
check the proof itself, because a contract cannot read GitHub. The agent does that,
the same way anyone else could: it asks GitHub for the gist or the profile README,
checks it belongs to that login, and checks it contains the claimed address. A claim
whose proof does not hold **is not paid**, and the agent does not quietly fall back
to the file: a broken claim has to hurt.

One wallet holds at most one login and one login at most one wallet, so the reverse
index is already a profile: from an address you reach its login, and from there its
settlements. That is the seed of the builder reputation in the roadmap.

While a developer has not claimed their login, `mergit.json` still works.

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

The verifier chooses who gets paid, and that is its only power. It cannot
change the amount, settle twice, settle after the deadline, or touch any other
bounty. Nothing in the contract stops it from naming an address it controls, so
that one choice is trusted today; binding the payout to the pull request
author's registered wallet is what removes it.
