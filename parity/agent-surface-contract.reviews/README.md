# Agent Surface Contract Reviews

This directory stores structured implementation-contract verdicts for
`parity/agent-surface-contract.json`.

Expected files:

- `<row-id>.json` for every matrix row
- `_contract.json` for the full matrix review

The default checker is a clean-checkout gate. It validates the matrix shape,
the pinned source commit and SHA-256 metadata, every referenced AgenC target
and test file, and the row commands without requiring a sibling source checkout.
The reviewed gate also requires each verdict file to be present and to report
`"verdict": "APPROVED"` when `--require-reviews` is used. The contract-level
verdict is bound to the current canonical-JSON matrix digest and source commit,
so a matrix edit cannot reuse stale approval evidence and checkout line endings
do not change the identity. An explicit `--require-reviews` cannot be disabled
by ambient row-review state.

When refreshing or auditing the source side of the contract, verify the pinned
files explicitly:

```bash
npm run check:agent-surface-contract:source
# Or point at a source checkout in another location:
node scripts/check-agent-surface-contract.mjs \
  --verify-source --source-root /path/to/source/codex-rs --no-run-commands
```

Source verification is fail-closed: the requested source root must be inside a
Git checkout at the recorded commit, every ledger digest must match that
commit's Git blob, and every pinned worktree file must exist and match through
Git's normal clean filters. Replace refs, index skip flags, and checkout line
endings cannot substitute different source bytes. It is intentionally separate
from the required clean-checkout gate so hosted CI does not depend on mutable
developer-local directory layout.

These JSON files are review evidence. Do not edit them as ordinary prose docs;
if a verdict becomes stale, rerun or replace the review evidence and then run
`npm run check:agent-surface-contract:reviewed`.
