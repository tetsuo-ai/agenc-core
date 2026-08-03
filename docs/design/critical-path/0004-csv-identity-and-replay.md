# CP-0004: Separate CSV source, item, and path identities

| Field | Value |
| --- | --- |
| Status | Implemented |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owner | CSV identity, import visibility, and replay safety (B1); consumed by bounded CSV scheduling and workflows |
| Compatibility | Additive state first; public result pagination and identity semantics are explicit changes |

## Context

Configured CSV IDs can be blank, duplicate, or invalid as agent path segments.
The audited implementation can use the same string as user identity, repository
identity, and agent name. Restart also lacks enough durable effect evidence to
distinguish safe replay from an ambiguous dispatched worker.

## Decision

CSV jobs use three distinct identities.

- `source_id` is the exact configured user value, preserved byte-for-byte. It
  is absent/null when no `id_column` was configured.
- `item_id` is an opaque deterministic repository ID derived from immutable job
  identity, row index, and a full stable content hash with collision detection.
- Agent/path identity uses a runtime-owned safe prefix, row index, and hash. A
  user value never becomes a path component.

When `id_column` is configured, the header must exist, each value must be
nonblank under the documented whitespace check, and exact duplicates are
rejected with both row numbers. The original value is not trimmed or
normalized. When omitted, the compatibility mode remains supported: no source
ID is invented, output contains the documented empty source-ID cell, and
internal identity derives from job/row content.

Headers and values are represented by `Map` or null-prototype objects populated
with data descriptors. `__proto__`, `constructor`, and `prototype` are inert
data unless they collide with a reserved output field.

### Import visibility

Validated rows enter repository-owned staging under an unguessable import ID.
No job or item is executable before EOF, all bounds, identity uniqueness, and
the staging digest validate. Promotion is an atomic visibility-fence change;
every runnable/read selector joins that fence. Abort or crash cleanup is scoped
to one proven-dead import lease.

### Outcome and replay

Item status gains `unknown_outcome`. The target job-status enum becomes exactly
`pending`, `running`, `completed`, `failed`, `cancelled`, `needs_review`, or
`finished_with_unknown_outcomes`; there is no job-level `unknown_outcome` value.
Unresolved ambiguous items aggregate to `needs_review`. A terminal item
contributes to `finished_with_unknown_outcomes` only when its canonical
disposition remains `remains_unknown` and its domain action is `abandon_item`;
`confirmed_committed`/`mark_completed` and
`confirmed_no_effect`/`retry_new_attempt` follow their resolved outcome paths.
Result presence is separately `not_produced`, `available`, or
`unavailable_after_review`.

Ambiguous items reference CP-0001 effect/review evidence. At-most-once is the
default. Automatic restart replay requires a registered, versioned
`CsvIdempotencyProfile`, a pre-dispatch unique operation key derived without an
attempt number, provider acknowledgement that the key was used, and a bounded
authoritative lookup/rendezvous. Missing or legacy evidence becomes review,
never a fabricated retry key.

The public result is a bounded, versioned summary plus keyset-paginated item
inspection and a separate bounded result-blob API. No compatibility adapter may
materialize every row of a large job. Continuation cursors are opaque and bound
to the exact job and status filter; clients pass `next_cursor` back unchanged,
and stale, forged, or cross-scope cursors fail closed.

### Prompt boundary

Approved job instructions and row/template substitutions use CP-0008. Each row
field remains an untrusted structured block with column, exact value, item/row
identity, and digest. Delimiter-like data cannot become privileged task text.

## Migration and rollout

Add import fences, identity columns/constraints, exact statuses, result
availability, review references, counters, and quota evidence before new
writes. Migrate generated SDK/CLI readers with the public contract. Historical
CSV output is never rewritten in place. A legacy running row without an
authoritative child/effect correlation becomes `legacy_csv_ambiguous` review
state and remains non-executable.

## Rollback

Rollback leaves import fences, ambiguous rows, and review evidence
non-executable. It may continue serving historical artifacts with a compatible
reader but cannot restore source-ID-as-path behavior or an unbounded all-items
response.

## Alternatives rejected

- Sanitizing a user ID and using the result everywhere.
- Inventing a source ID when `id_column` is absent.
- Treating CSV output overwrite as proof worker execution is idempotent.
- Replaying every legacy `running` row.

## Verification obligations

Fixtures cover no-ID compatibility, exact Unicode/whitespace IDs, duplicate
IDs, reserved fields, prototype-shaped headers, quoted CR/LF, and legacy
pending/running/completed rows. Tests prove exact round trips, safe paths,
visibility fencing, unknown review behavior, and no duplicate physical effect.

Primary references: [RIFL](https://web.stanford.edu/~ouster/cgi-bin/papers/rifl.pdf),
[OrchBench](https://arxiv.org/abs/2607.25656), and
[The Instruction Hierarchy](https://arxiv.org/abs/2404.13208).

## Implementation

The contract and named limits live in
`runtime/src/contracts/csv-job-contract.ts`. Migration `019` installs the
visibility fence, identity/evidence columns, exact status enums, counters, and
quota triggers; the state driver takes a pre-migration rollback backup.
`runtime/src/state/csv-agent-jobs.ts` owns atomic import promotion, transition
guards, review resolution, keyset pages, result chunks, retirement, and stale
staging cleanup.

`runtime/src/agents/jobs/csv-reader.ts` performs descriptor-based bounded UTF-8
ingestion and creates inert rows plus runtime-owned identities.
`runtime/src/agents/jobs/job-orchestrator.ts` keeps approved instructions apart
from structured row data, dispatches through cancellable FIFO admission, holds
capacity until workers retire, and applies the replay rules above. The
model-facing surface returns only a versioned summary and first bounded page;
operators use `inspect_csv_agent_job` and `read_csv_agent_job_result` for
bounded follow-up reads.
