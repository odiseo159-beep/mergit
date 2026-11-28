# Releasing mergit-mcp

The npm package is one file, `dist/mergit-mcp.mjs`, built by `build.mjs`. It **copies** the
decision code from `agent/` at build time. So the published package keeps the rules it was built
with until the next release.

## When a new release is required

Publish a new version whenever any of these change:

- `agent/bounties.mjs`, `agent/verify.mjs`, `agent/registry.mjs` or `agent/chain.mjs`: the rules
  that decide which bounty a pull request collects, which wallet gets it, and what counts as CI.
- An escrow, the registry or the agent's address: `ESCROWS`, `REGISTRY` and `AGENT` in `tools.mjs`.
- The site's URLs that the tools return: `/post`, `/register`, `/record/<login>.json`, `/p/<login>`.

If the agent starts paying under different rules and the package is not republished, the tool will
tell people "this will pay" when it will not. That is the one failure that matters.

## Steps

```
cd mcp
npm version patch        # or minor / major, see CHANGELOG.md for the rule
# edit CHANGELOG.md
npm publish --access public
```

`prepublishOnly` runs the offline tests, builds the bundle and runs the protocol smoke test against
the bundle, over the network. If any of them fails, nothing is published.

Then commit the version bump and the changelog, and tag it `mcp-vX.Y.Z`.

## If a broken version goes out

`npm deprecate mergit-mcp@X.Y.Z "broken: use X.Y.Z+1"` and publish a fix. Unpublishing is only
possible in the first 72 hours and breaks anyone who pinned it, so prefer deprecating.

## Housekeeping

- Bump `@modelcontextprotocol/sdk` and `esbuild` deliberately, run the tests, publish a patch.
- The npm account that owns the package should have two-factor authentication on.
