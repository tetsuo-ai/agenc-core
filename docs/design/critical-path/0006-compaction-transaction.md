# CP-0006: Make compaction a rollback-capable transaction

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owner | Transactional, injection-safe context compaction (C2) |
| Compatibility | Strict event/pin readers precede new writers; older readers refuse affected sessions |

## Context

The audited compaction path can concatenate policy and transcript content,
accept provider failure or truncation through a fixed-character fallback, and
replace in-memory history before every caller has durably committed the same
decision. A failed or no-shrink summary must not destroy the source conversation,
and transcript or tool text must not acquire instruction authority.

## Decision

Compaction is the explicit transaction:

`prepare -> pin -> intent -> summarize -> validate -> durable commit -> projection -> cleanup`

Only a durably flushed `compaction_committed` event changes canonical active
history. Provider completion, a candidate summary, in-memory replacement, and
cleanup are not commit points.

### Source authority and retention

The append-only canonical rollout remains source authority. Every attempt binds
a versioned immutable span reference containing session/epoch, exact sequence or
legacy byte bounds, source binding, and SHA-256.

Under the rollout writer/pruner exclusion, the runtime first creates an
idempotent retention pin, then appends and flushes `compaction_intent` with the
attempt, source, policy, configuration, and accounting digests. Pin state is
exactly `preparing`, `intent_bound`, `committed_reference`, `release_pending`,
or `released`. A crash after pin but before intent creates a reconciliation
candidate, never permission to prune.

An active reference does not expire by wall clock. A committed source span has a
minimum seven-day rollback-eligibility window. After that window, release still
requires proof that no active history, checkpoint, branch, descendant
compaction, extension, or provenance reference needs the bytes. The owner then
flushes `compaction_source_release` before bounded pruning and finalizes the pin
idempotently. Missing proof keeps the source pinned.

### Structured, bounded summarization

Immutable policy and output schema use the privileged instruction channel.
Transcript, tool output, and prior summaries are untrusted structured data;
their bytes are never interpolated into control delimiters. Complete semantic
units preserve order and never separate a tool use from its result or lose the
checkpoint-bound result digest from CP-0003.

The reduction plan is a bounded, preflighted map/reduce tree. It reserves policy,
schema, and output tokens; caps source bytes/messages/units, chunks, levels,
fan-in, provider calls, total tokens, output bytes/nodes, and wall time; and
rejects an unrepresentable unit instead of slicing it. Every provider call is
admitted and accounted independently from the compaction transaction.

Accepted output is strict `CompactionSummaryV1`. The runtime supplies trusted
wrapper identity and permits the model to return only bounded body fields and
source IDs from an allowlist. Ordered provenance expands to every planned source
span exactly once. Unknown or duplicate fields/keys/references, cycles,
overlaps, missing or reordered leaves, non-finite/exotic values, and forged
wrapper fields fail before commit.

`summary_sha256` is SHA-256 over the ASCII domain separator
`agenc.compaction-summary.v1\0` followed by UTF-8 RFC 8785 canonical JSON of the
complete trusted wrapper with `summary_sha256` omitted. The response must finish
with `stop`, satisfy the strict schema and provenance graph, fit the target
context, save at least 1,024 tokens, and reduce tokens by at least 20 percent.

### Failure, commit, and projection

After an intent exists, every provider, abort, limit, schema, provenance,
injection, no-shrink, or commit-precondition failure leaves original history
active and appends a typed, flushed `compaction_failed` event. If that failure
event cannot be recorded, the pin remains for startup reconciliation. A
deterministic extract may support diagnostics but can never replace history.

The loop guard permits at most two failed automatic attempts for the same source
history/configuration digest. Restart reconstructs that guard; only changed
history/configuration or an explicit observable manual action permits another
attempt.

Once `compaction_committed` is flushed, restart applies it deterministically. A
projection failure poisons the session as `reconstruction_required` and blocks
new turns; it does not turn the operation back into a retryable non-commit.
Cleanup failure records or retains `cleanup_pending` and repairs idempotently.

An operator rollback validates source identity and digest, then flushes
`compaction_rollback_committed` before projection changes. It may restore the
same session only when no later event/checkpoint exists; otherwise it creates a
reviewed branch so newer work is retained. Operators may extend but never
shorten the minimum retention window.

## Migration and rollout

Land strict readers and startup reconciliation for pins,
`compaction_intent`, `compaction_failed`, `compaction_committed`,
`compaction_rollback_committed`, `compaction_source_release`, and
`cleanup_pending` before any writer. Each record carries a format and minimum
reader requirement. Keep compaction non-destructive until restart, rollback,
provenance, and injection matrices pass. Then switch every caller to
durable-commit-before-projection ordering.

## Rollback

Safe rollback disables new automatic compaction, completes reconciliation with
the minimum compatible reader, and retains source spans and pins. An older
runtime MUST refuse a session containing the new events. Rollback never restores
the destructive fallback, ignores an intent, or prunes source to reduce storage
pressure.

## Alternatives rejected

- Treating provider success or in-memory mutation as the commit point.
- Replacing history with a head/tail character extract after provider failure.
- Expiring an active pin solely because its wall-clock TTL elapsed.
- Summarizing open-endedly until the result happens to fit.
- Flattening transcript data into the compaction instruction.

## Verification obligations

Inject failure at every pin, append, flush, provider, validation, projection,
release, prune, and restart boundary. Tests MUST prove original history remains
active before commit; commit is reconstructed exactly once afterward; cleanup
cannot undo it; and rollback never discards later work. Boundary and
boundary-plus-one tests cover every resource limit and semantic-unit rule.
Adversarial transcripts, tool outputs, duplicate keys, forged provenance, and
non-`stop` responses cannot change policy or commit.

Benchmarks compare deterministic and provider-native candidates on held-out
conversations for quality, shrink, calls, tokens, latency, RSS, and operation
counts under the same safety contract.

Primary references: [The Instruction Hierarchy](https://arxiv.org/abs/2404.13208),
[ACON](https://arxiv.org/abs/2510.00615),
[Context as a Tool](https://aclanthology.org/2026.findings-acl.1032/),
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), and
[PoWER Never Corrupts](https://www.usenix.org/conference/osdi25/presentation/leblanc).
