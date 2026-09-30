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
added to the public repository. Excluded active work will receive a later frozen
snapshot rather than an inconsistent copy.

The importer, `scripts/preserve-light-work.mjs`, is a one-use preservation tool
with an audit mode. It neither launches a client/provider nor writes a financial
ledger. Its credential-pattern check is a precaution, not a proof of arbitrary
content safety. Do not use it to blanket-publish private operational archives.
