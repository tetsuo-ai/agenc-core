# embedded-neovim-buffer review verdicts

Reviewer subagents write structured JSON verdicts here. The contract checker reads them when --require-reviews is used.

- Per-row verdicts: `<row.id>.json` (one file per row, written by the row-reviewer subagent).
- Contract verdict: `_contract.json` (single file, written by the contract-reviewer subagent).

Both files must report `"verdict": "APPROVED"` for the contract checker to pass. See the row-reviewer and contract-reviewer agent specs for the exact JSON shape.

Do not edit verdict files by hand; they are evidence. If a verdict is wrong, fix the implementation or the reviewer prompt and rerun the reviewer.
