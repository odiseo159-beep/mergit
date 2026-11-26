# Changelog

All notable changes to `mergit-mcp`. Versions follow semver: a new tool or field is a minor
version, a fix is a patch, removing or renaming a tool or field is a major version.

## 0.1.0 — 2026-11-25

First release.

- Tools: `mergit_list_open_bounties`, `mergit_get_bounty`, `mergit_check_pull_request`,
  `mergit_builder_record`, `mergit_fund_link`, `mergit_payout_setup`.
- Prompt: `write_bounty_spec`.
- Read-only. No key, no signing. Escrows v1 and v2 and the identity registry on GIWA Sepolia.
- Decision rules bundled from `agent/` at build time.
