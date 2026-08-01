# CP-0005: Publish only complete derived-index generations

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | Persistent fuzzy-file indexing (D2) and full-corpus memory indexing (C3b) |
| Compatibility | Additive freshness metadata and shadow generations before atomic reader cutover |

## Context

Filesystem and memory search need persistent indexes to avoid repeated full
walks and newest-only candidate truncation. Those indexes are derived caches,
not source authority. Publishing a discovered prefix, mixing build generations,
or calling an old generation fresh after watcher loss would make results depend
on crash timing rather than source state.

Size and modification time are not sufficient identity: content can change
while both remain constant. Watchers are also advisory and can be unavailable,
overflow, coalesce events, or lose state across process death.

## Decision

A reader MUST observe one complete, immutable index generation. A building,
failed, or superseded staging generation is never queryable as current state.
Source files remain authoritative and the index always remains rebuildable.

### Generation identity and publication

Each generation binds at least:

- an index kind and schema/collation version;
- a canonical root identity and source-policy/configuration digest;
- a unique build epoch;
- the discovery and change-log boundaries it incorporates;
- complete item, byte, item-fingerprint, and generation-digest totals; and
- a terminal state that distinguishes staging, complete, failed, and retired
  generations.

Build work occurs in an invisible staging generation in bounded, restartable
slices. The build persists its root snapshot, work queue, uniqueness-protected
discovery spool, change-log cursor, counters, and elapsed active work after each
slice. A process restart reenumerates an interrupted directory because native
directory handles are not durable; exact uniqueness suppresses duplicates.

Publication is one atomic metadata transaction that proves discovery is
complete, source changes through the bound cursor have been incorporated, all
integrity checks passed, and the schema remains current. Readers opened before
the swap may finish on the old complete generation. New readers see only the
new generation. No reader may observe a row-by-row mixture.

A published generation is immutable. Every owned or externally observed
mutation is copy-on-write: it is applied to a new staging generation (or a new
generation derived from the last complete snapshot), validated, and atomically
published. Mutations may be coalesced within documented freshness bounds, but
they never update rows in the published generation in place. Readers already
holding the old generation finish against that snapshot.

### Per-index digest basis

Every item fingerprint is domain-separated and binds the owning index kind and
schema version. Its exact source preimage differs by index semantics:

- The fuzzy-file index binds canonical portable path bytes, entry type, the
  normalized display/search path metadata, canonical-root identity, source and
  ignore policy, and schema version. It does not read or hash file bodies.
- The memory index binds canonical file identity/path, the exact bounded header
  bytes used by retrieval, normalized searchable metadata, source policy, and
  schema version. Size and modification time are observations, never substitutes
  for those bytes.

The generation digest binds the root/configuration identity, source/change
boundary, and the stable ordered sequence of exact item identities,
fingerprints, and byte counts. Implementations may use tree or page digests for
incremental construction only when the resulting root commits to that same
ordered set without collision-prone shortcuts.

### Freshness contract

- AgenC-owned mutations immediately create or update the next staging generation
  under the same root identity and publish it through the copy-on-write rule;
  they never mutate the generation visible to existing readers.
- Best-effort root watchers debounce and coalesce external changes. Unsupported
  watchers, overflow, lost state, or an overfull change log make freshness
  visibly stale or degraded; they never make a staging generation publishable.
- A bounded, keyset-paginated integrity audit with persisted progress repairs
  missed changes. Scheduling uses measured pass duration and backoff rather than
  a fixed unbounded rescan interval.
- A successful explicit refresh is strongly fresh: a complete generation covers
  the source boundary established by that request. A wait timeout returns a
  typed pending or resource-limited result and generation token; it does not
  relabel the previous generation as fresh.
- Every query reports the complete generation identity and age, watcher health,
  audit/build progress, and applicable stale, truncated, or degraded state.

A watcher overflow during any build slice invalidates that build's completeness
proof until a full bounded audit or rebuild converges. For memory headers, a
same-size/same-mtime change still changes the item fingerprint because exact
bounded header bytes are in its preimage. The path-only fuzzy-file fingerprint
uses its path/metadata preimage and never reads file bodies merely to detect such
a change.

### Isolation and lifecycle

Derived stores live under an AgenC-owned private directory with user-only files.
Canonical-root aliases deduplicate before indexing. Cross-process writers use a
bounded lease and transaction policy; corruption, root moves, and schema changes
build replacements without destroying the last complete generation.

Root, byte, generation, watcher, worker, queue, and build-work limits are named
and enforced before growth. Cleanup is scoped and keyset-paged, protects active
readers/builders, and deletes only derived cache state. TTL or storage pressure
never deletes source files or the sole complete generation needed by an active
owner.

Fuzzy-file and memory indexes MAY share generic filesystem freshness
primitives. They MUST retain separate schemas, relevance semantics, source
policies, ranking state, and retention ownership.

## Migration and rollout

Land generation readers, freshness response fields, schema/version checks, and
scoped cleanup before production writers. Build shadow generations, compare
them with direct source oracles, then atomically switch readers. Protocol and
SDK freshness fields are additive; no caller may infer strong freshness from
their absence.

## Rollback

Rollback disables new builds and serves the last compatible complete generation
with truthful stale metadata, or uses the bounded direct fallback defined by the
owning subsystem. Scoped index management may delete and rebuild derived state.
It MUST NOT delete source data, publish a partial generation, or silently return
an old generation as fresh.

## Alternatives rejected

- Updating the visible index in place during a full rebuild.
- Publishing a prefix when a time or file limit is reached.
- Treating watcher silence, size, and mtime as complete freshness proof.
- Using a fixed frequent full-tree scan as the external-change strategy.
- Sharing one relevance or retention model between fuzzy-file and memory search.

## Verification obligations

Inject crashes before and after every slice checkpoint and publication step.
Tests cover create/update/delete/rename, same-size/same-mtime replacement,
watcher overflow, corrupt staging and complete indexes, schema migration, root
move, two writers, cleanup interruption, explicit-refresh timeout, and restart.
A million-entry generated corpus MUST cross many slices while queries continue
to see only the prior complete generation; the final swap becomes visible at
once and never exposes duplicates or a prefix.

Build work is linear in bounded indexed input bytes. Warm queries do not walk
the filesystem. Benchmarks report build and incremental-update time, query
p50/p95, RSS, store size, watcher/audit cost, contention, and operation counts.

Primary references: SQLite's [atomic commit](https://www.sqlite.org/atomiccommit.html),
[LongMemEval](https://arxiv.org/abs/2410.10813),
[BRIGHT](https://arxiv.org/abs/2407.12883), and
[ClawArena](https://arxiv.org/abs/2604.04202).
