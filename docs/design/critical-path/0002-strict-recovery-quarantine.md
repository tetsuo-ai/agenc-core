# CP-0002: Use strict canonical recovery with quarantine

| Field | Value |
| --- | --- |
| Status | Implemented |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | Strict recovery contracts (A2a), bounded projection (E1a), and authoritative recovery cutover (A2b) |
| Compatibility | Additive schema/readers, bounded mechanism, then authoritative cutover |

## Context

Canonical JSONL recovery can currently skip a malformed interior record and
project later records. A partial or corrupt source must not become authority for
executable work. At the same time, transient database, descriptor, lock, or
startup-budget failures are not proof that source bytes are corrupt.

## Decision

Canonical recovery MUST be strict, bounded, and validate-before-project.
Tolerant parsing MAY support non-authoritative search or conversational
projections, but its result type MUST NOT be accepted by executable recovery.

### Format lanes

- A sequenced journal starts at the version-defined sequence and increments
  contiguously. Duplicate, rewound, or missing sequences fail.
- A legacy unsequenced journal keeps strict line/schema/order validation and
  the existing allowance for repeated synthetic IDs with distinct content. It
  makes no continuity claim and is upgraded under the single-writer lease
  before new sequenced writes or resume.
- One source cannot opportunistically mix the two lanes.

Every record retains line number, byte offset, encoded byte length, sequence
facts, and rolling/source SHA-256. A digest is trustworthy only when matched to
an existing durable binding or when a descriptor-pinned scan proves the source
stable through commit.

### Classification

`run_recovery_quarantine` is for deterministic source-integrity failures:
malformed/schema-invalid records, sequence defects, identity conflicts,
required missing or duplicate terminals, trusted digest mismatch, changed
stable lease-owned source, and per-source format ceilings.

`run_recovery_deferred` is for operational unavailability: live/maybe-live
writer, source not quiescent, database busy/I/O, descriptor pressure,
projection failure, aggregate startup byte/time limits, or bounded concurrency
limits. Both states are non-executable.

If SQLite cannot record a deferred row, startup retains an in-memory
`recovery_storage_unavailable` block. Executable recovery may resume only after
the durable row is transactionally persisted.

### Terminal and interruption rules

A sealed source, durable terminal binding, or later evidence whose schema
requires a terminal contains exactly one matching terminal. A started but
unsealed turn interrupted by process death is not corrupt solely because it
lacks one. It becomes non-executable `process_killed` state and only an
A3-validated resumable descriptor may reach the resume consumer. Raw stale
`running` state is never authority.

### Incident lifecycle

Quarantine records retain immutable incident identity, deterministic
domain-separated fingerprint, run/source binding, stable reason code, safe
offset/sequence facts, source metadata/digest, first/last observation, count,
and resolution history. One active incident exists per run/source binding.
Redetection increments bounded observations; recurrence after resolution
creates a linked new incident rather than reopening the old one.

Operational blocks have their own deterministic active key, attempts, error
class, retry time, and immutable resolution history. Active evidence is never
pruned to make work executable.

Operator actions are separate list/show/rescan/repair/abandon operations.
Repair requires a confirmed current source hash and successful strict replay in
the same transaction that removes exclusion. Abandonment writes an immutable
`recovery_abandoned` tombstone and permanently excludes the original run. There
is no generic clear-all operation.

### Projection

One validated run projects in one SQLite transaction. E1a supplies a
descriptor-pinned two-pass reader so a million-event run does not require an
event array. Any content mismatch rolls back the entire projection. A2b binds
quarantine, deferral, and abandonment exclusions into every executable
recovery selector.

The E1a mechanism keeps the same read-only descriptor and session lease across
both passes. Its first pass uses disk-backed exact identity claims; its second
pass is anchored to the first digest and streams rows directly into the
projection transaction. Per-source line/byte/event ceilings are integrity
failures. Aggregate read/time and descriptor ceilings are operational blocks.
The normal CLI installs the mutation adapter. Startup, on-demand inspection,
stale-tool restoration, final recoverable-run loading, and admission-journal
convergence all consume the same durable exclusion predicate.

## Migration and rollout

The order is fixed: A2a types/schema/readers, E1a bounded two-pass mechanism and
A3 resume validation, then A2b authoritative caller cutover. Initial strict
diagnostics may run against copies, but production authority ultimately fails
closed.

The A2a landing installed the strict byte contract and durable evidence model;
E1a added bounded descriptor-pinned two-pass I/O. A2b made it authoritative,
installed the operator adapter, and bound active quarantine, active deferral,
and permanent abandonment to every executable recovery selector. Tolerant
non-authoritative indexing remains for compatibility.

## Rollback

Rollback disables executable recovery and preserves every incident, block, and
tombstone. It never restores the tolerant canonical parser and never uses an
older runtime that ignores the new exclusion evidence.

## Alternatives rejected

- Computing a fresh hash and calling it integrity proof.
- Treating resource exhaustion as corruption.
- Projecting a validated prefix.
- Clearing or deleting incidents to resume work.
- Mixing legacy and sequenced rules record by record.

## Verification obligations

Fixtures cover valid sequenced data, repeated legacy IDs, malformed interior
records, sequence gaps, and an unterminated tail. Tests MUST prove zero partial
projection, idempotent incident creation, strict operator transitions, and
exclusion through every recovery entrypoint.

Primary references: [PoWER Never Corrupts](https://www.usenix.org/conference/osdi25/presentation/leblanc)
and SQLite's [atomic commit](https://www.sqlite.org/atomiccommit.html) and
[`synchronous`](https://sqlite.org/pragma.html#pragma_synchronous) guidance.
