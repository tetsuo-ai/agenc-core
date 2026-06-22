# Embedded Neovim BUFFER Review Verdicts

This directory stores structured JSON verdicts for
`parity/embedded-neovim-buffer.json`. The contract wrapper reads them when the
reviewed gate is used.

- Per-row verdicts: `<row.id>.json` (one file per row).
- Contract verdict: `_contract.json` (one aggregate verdict).

Both files must report `"verdict": "APPROVED"` for the contract checker to
pass. The wrapper and implementation-contract checker enforce the JSON shape.

Do not edit verdict files by hand; they are evidence. If a verdict is wrong,
fix the implementation or replace the review evidence, then rerun
`node scripts/check-embedded-neovim-buffer.mjs`.
