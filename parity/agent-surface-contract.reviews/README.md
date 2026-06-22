# Agent Surface Contract Reviews

This directory stores structured implementation-contract verdicts for
`parity/agent-surface-contract.json`.

Expected files:

- `<row-id>.json` for every matrix row
- `_contract.json` for the full matrix review

The default checker validates the matrix shape, referenced files, and row
commands. The reviewed gate also requires each verdict file to be present and to
report `"verdict": "APPROVED"` when `--require-reviews` is used.

These JSON files are review evidence. Do not edit them as ordinary prose docs;
if a verdict becomes stale, rerun or replace the review evidence and then run
`npm run check:agent-surface-contract:reviewed`.
