# Agent Surface Contract Reviews

This directory stores structured implementation-contract verdicts for `parity/agent-surface-contract.json`.

Expected files:

- `<row-id>.json` for every matrix row
- `_contract.json` for the full matrix review

The default checker validates the matrix and row commands. The reviewed gate
requires these verdicts to be present and approved when `--require-reviews` is
used.
