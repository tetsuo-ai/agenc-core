# CP-0003: Version durable checkpoints and bind complete tool results

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owner | Checkpoint digest, ordered tool pairing, and legacy migration (A3); consumed by recovery and compaction |
| Compatibility | New writes use a new version; legacy resume requires atomic proof/upgrade |

## Context

The audited checkpoint prefix hash excludes tool-result bodies so two different
results can produce the same checkpoint. Tool-result pairing also collects IDs
without proving ordered, unique use/result relationships.

## Decision

Before bounding, truncating, or summarizing a result, the runtime MUST compute a
domain-separated SHA-256 over its exact canonical persisted representation. The
durable result event binds:

- digest algorithm and version;
- SHA-256;
- exact encoded byte length;
- result identity;
- tool-call identity; and
- the canonical representation version.

The new checkpoint version includes this digest and structural metadata rather
than the potentially large body. Readers dispatch explicitly by version and
reject unknown versions.

### Ordered pairing

One shared streaming validator is used by live append, reconstruction,
compaction chunking, and resume:

1. A tool use opens one unique call ID.
2. A result references a previously opened unresolved call.
3. Result-before-use, duplicate call ID, duplicate result, orphan result, and
   incompatible ordering are typed integrity failures.
4. Only calls still open at end-of-input are dangling.

Uniqueness is exact across resolved and open calls. The heap retains only the
bounded unresolved set; an exact SQLite unique index/staging table retains full
IDs for the validated run. Hashes may accelerate lookup but collisions compare
the complete ID.

The initial limits are the values frozen by A3:
`MAX_TOOL_CALL_IDS_PER_RUN = 1_000_000`,
`MAX_OPEN_TOOL_CALLS_PER_RUN = 4_096`,
`MAX_TOOL_CALL_ID_UTF8_BYTES = 4_096`, and
`MAX_TOOL_CALL_ID_INDEX_BYTES_PER_RUN = 268_435_456`.
Overflow is a non-executable recovery deferral.

### Legacy checkpoints

A legacy checkpoint may resume only when the original result bytes remain
available, their trustworthy digest can be derived, and the checkpoint is
atomically upgraded. Otherwise the runtime halts resumable execution with the
run identity and safe recovery options. The old weak hash is never treated as
equivalent to the new version.

Logs expose only safe IDs and digest prefixes, never result content. Digest
comparison is constant-time where practical.

## Migration and rollout

The versioned reader and migration land before the writer. The checkpoint
boundary records a minimum compatible reader. C2 preserves these result digests
through semantic-unit chunking; A2 only hands an interrupted run to resume after
this validation succeeds.

## Rollback

Once a new checkpoint exists, older readers refuse that run. Safe rollback
disables resume while retaining checkpoint/result evidence and uses the minimum
compatible reader to inspect or export it.

## Alternatives rejected

- Hashing only result identity or a size class.
- Hashing the already-truncated body.
- Tracking only currently open IDs in memory.
- Accepting old and new fields heuristically without a version.

## Verification obligations

The paired fixtures differ only in tool-result body content and MUST yield
different new checkpoints. Tests cover bit flips, truncation, substitution,
reordering, every invalid pairing, exact-ID limits, collision behavior, legacy
upgrade, and restart during upgrade.

Primary references: [PoWER Never Corrupts](https://www.usenix.org/conference/osdi25/presentation/leblanc)
and SQLite's [checksum VFS](https://sqlite.org/cksumvfs.html) guidance.
