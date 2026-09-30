# Preserved Light evaluation source — 2026-09-30

This directory preserves the operator-side source for the Light work described
in [the integration checkpoint](../../../docs/eval/light-integration-2026-09-30.md).
It is **not shipped runtime code, an installation, or approval to run benchmarks**.

`code/SOURCE-MANIFEST.json` records the original relative paths, byte lengths and
SHA-256 hashes of 420 copied source/configuration files. Files were copied without
rewriting absolute paths, source pins, execution guards, failed prototypes or
historical claims. Some scripts therefore reference the original private working
directories and cannot run from this checkout without a separately reviewed
relocation. No archived build or test was executed during this import. In
particular, do not reset one-use run markers or relaunch completed paid cells.

Current production changes are in `runtime/`, on this same branch; their verified
scope and the absence of a current matched Light/Pi result are documented in the
integration checkpoint. Archived fixtures include superseded and deliberately
failing versions. A filename or a passing fixture is not deployment authority.

Full evaluation documents, result JSON, logs and provenance are preserved in the
**private** `tetsuo-ai/agenc-desktop` repository, branch
`archive/claude-session-4e2cff2c`, under `light-evaluation-2026-09-30/takeover/`.
That archive includes a per-file preservation manifest and explicit exclusions.
The original Claude session archive on that branch remains unchanged. Credentials,
raw session exports, dependency caches and active worker files were not silently
added to the public repository. The callback worker has now frozen its two files;
their separate `frozen-callbacks/` snapshot is **untested draft code**, not an
accepted integration or permission to execute clients.

## Supplemental preservation

The complete selected public source inventory is now 848 original files. Each
snapshot has a `SOURCE-MANIFEST.json` with byte lengths and SHA-256 hashes:

| Snapshot | Original source/config files | Scope |
| --- | ---: | --- |
| `code/` | 420 | Codex takeover implementation and evaluation prototypes |
| `predecessors/light-runtime/` | 28 | Runtime overhead harness |
| `predecessors/light-ultra/` | 225 | Historical prompt/runtime experiment harnesses |
| `predecessors/light-port/` | 104 | Ported and fair-check harnesses |
| `predecessors/light-models/` | 61 | Historical model harnesses |
| `predecessors/light-diag/` | 1 | Diagnostic script |
| `runtime-overhead-overlay/` | 4 | Uncommitted report/test/script overlay, preserved without altering its source checkout |
| `frozen-callbacks/` | 2 | Unexecuted callback and test drafts |
| `ultra-scanner/`, `port-scanners/` | 3 | Reviewed credential-detection source, not credentials |

The runtime overlay's baseline is commit
`2da4a495cf91a59adc97d50d5b8426653187cb4e`; filenames map to
`runtime/benchmarks/runtime-overhead/` in that checkout. It is not a patch applied
to the current runtime. The 11 task manifests/pricing tables are historical
source inputs, not verification of today's prices or model authorization.

Nineteen embedded experimental repository heads were checked against fresh
remote advertised branch tips; all are already retained remotely. They remain
separate experimental branches, not ancestors of the current integration branch.
Third-party checkouts, dependencies and rebuildable binary bundles are not copied
into this directory. Private accounting ledgers are retained only in Desktop,
without reconciliation, retries or mutation. See the private archive's inventory
for exact source locations, references and exclusions.

The importer, `scripts/preserve-light-work.mjs`, is a one-use preservation tool
with an audit mode. It neither launches a client/provider nor writes a financial
ledger. Its credential-pattern check is a precaution, not a proof of arbitrary
content safety. Do not use it to blanket-publish private operational archives.

## Subsequent callback validation

`callback-validation-v1/` adds six source/configuration/document files as a
separate versioned snapshot; it does not overwrite the frozen draft. The callback
has now passed 25 offline tests and strict types. Read its validation note for
the first failed typecheck, exact hashes and limits. Its six private log/result
files are retained only in Desktop. These additions are separate from the
original 848-file preservation count above. No real-client or performance claim.
