# CP-0006: Make compaction a rollback-capable transaction

| Field | Value |
| --- | --- |
| Status | Shipped (0.14.0+). This header used to say "implementation pending"; the [critical-path README](README.md) is authoritative. |
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

### Implementation evidence

The local, provider-independent acceptance surface is split by failure phase:

| Phase | Required durable result |
| --- | --- |
| Source preparation, attachment preflight, or pin before intent | No compaction event; original history remains active. |
| Provider, accounting, schema, provenance, abort, or shrink after intent | Exactly one typed `compaction_failed`; original history remains active. |
| Durable commit append/flush | Ordinary adapter failures are classified as `commit_failed`; an indeterminate storage result remains pinned for startup reconciliation. |
| Projection after commit | The committed replacement remains authoritative and the session becomes `reconstruction_required`. |
| Cleanup after projection | The commit remains authoritative and `cleanup_pending` is repaired idempotently. |
| Abort after provider dispatch | The attempt-scoped admission tail and transaction lease remain open until the physical provider promise settles. |

The focused contract suite is
[`runtime/tests/services/compact/transaction-contract.test.ts`](../../../runtime/tests/services/compact/transaction-contract.test.ts).
Restart, rollback, retention, DAG, and source-authority mutation coverage is in
[`runtime/tests/session/rollout-store.compaction-transaction.test.ts`](../../../runtime/tests/session/rollout-store.compaction-transaction.test.ts).
Canonical payload chunking and maximum-input operation counts are covered by
[`runtime/tests/services/compact/payload-manifest.test.ts`](../../../runtime/tests/services/compact/payload-manifest.test.ts).

Run the reproducible maximum-scale algorithm benchmark with:

```sh
npm --workspace=@tetsuo-ai/runtime run benchmark:compaction
```

It exercises 100,000 compact active-history references, a 64 MiB canonical
source payload, the maximum 64-leaf/73-call DAG, and a 63-chunk near-maximum
admissible planner input. The benchmark reports deterministic splitter and
planner work, elapsed time, and RSS.

The versioned provider-independent replay is:

```sh
npm --workspace=@tetsuo-ai/runtime run check:compaction-offline
```

Its SHA-256-bound
[`held-out-corpus.v1.json`](../../../runtime/benchmarks/compaction/held-out-corpus.v1.json)
contains three maintenance conversations, 16 factual checks, 14
recovery-critical checks, and three injection canaries. The committed
[`offline-results.v1.json`](../../../runtime/benchmarks/compaction/offline-results.v1.json)
records quality, shrink, planned and executed calls, tokens, local latency, RSS,
and deterministic operation counts under common quality, injection,
provenance, shrink, and recovery gates. The C2 planner plus deterministic
extractive proxy passes every gate; the tail-window baseline demonstrates that
shrink alone can still lose facts, retain an injection canary, and fail
recovery.

This is explicitly `deterministic_offline` evidence: both labeled candidates
are non-provider-native, execute zero provider calls, and make no provider
quality claim. Provider-native quality, cost, and network-latency evidence
remains a separate, credentialed evaluation obligation.

Primary references: [The Instruction Hierarchy](https://arxiv.org/abs/2404.13208),
[ACON](https://arxiv.org/abs/2510.00615),
[Context as a Tool](https://aclanthology.org/2026.findings-acl.1032/),
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), and
[PoWER Never Corrupts](https://www.usenix.org/conference/osdi25/presentation/leblanc).

## Operator contract (current main)

The decision above is the durable-transaction spec. This section is the
live operator surface. Sources: `runtime/src/services/compact/autoCompact.ts`,
`compact.ts`, `transaction.ts`, `session/run-turn.ts`,
`commands/session-compact.ts`, and `budget/admitted-model-call.ts`.

### Entry points

| Path | Trigger | If it does not compact |
| --- | --- | --- |
| `/compact [focus]` | Manual. `querySource: "compact"`. Not gated by the disable env vars. | Error only. History stays as-is until a durable `compaction_committed`. |
| Pre-sampling auto | `autoCompactIfNeeded` when estimated tokens ≥ the safety threshold. | Increments `consecutiveFailures`. Three failures skip later autos this turn. User/provider abort does not count. |
| Mid-turn auto | Last sample `promptTokens` ≥ the mid-turn outer limit **and** the turn still needs follow-up (tools, mailbox, or `needsFollowUp`). | The turn terminates with `mid_turn_compact_failed` / `mid_turn_compact_skipped`. It does not retry in a loop. |

Same-context callers serialize on a `WeakMap` (`compactConversation`). A
second `/compact` or mid-turn auto against the same `CompactContext` awaits
the in-flight result instead of writing a competing summary.

Agent-invocation envelope messages are never summarized. The kept suffix is
about 20 percent of history (min 1, max 4; empty when there are two or fewer
messages), then walked forward so a tool result is not kept without its
parent `tool_calls` message.

### Thresholds

`getAutoCompactThreshold` uses the stricter of:

```text
min(window - 13_000, floor(window * 0.75))
```

`window` is `AGENC_AUTO_COMPACT_WINDOW` (positive integer) if set, else the
live `CompactContext.options.contextWindowTokens`, else the model-string
fallback (`lookupContextWindowForModel`: haiku/sonnet/opus → 200k, else the
openai-compat table, else 128k).

`AGENC_AUTOCOMPACT_PCT_OVERRIDE` is a percentage `1`–`100`. It can only make
auto-compact fire **earlier** than that default (it is capped at the safety
threshold).

Pre-sampling uses that threshold. The mid-turn **outer** gate is different:
`modelInfo.autoCompactTokenLimit` if set, otherwise `window - 13_000` only
(no 0.75 fraction). After that gate fires, `autoCompactIfNeeded` still
re-checks the 0.75/13k estimate. The two numbers can disagree: mid-turn
anchors on the last provider-reported `promptTokens`; the compact module
re-estimates with `estimateMessagesTokens` (system, tools, framing, reserved
output). A skip after the outer gate still ends the turn.

### Disable flags

Truthy values are `1`, `true`, `yes`, `on` (case-insensitive).

| Var | What it actually gates |
| --- | --- |
| `AGENC_DISABLE_AUTO_COMPACT` | Auto-compact **and** the mid-turn/notice outer gate. |
| `AGENC_DISABLE_COMPACT` | `autoCompactIfNeeded` only. The mid-turn outer gate does **not** consult it. |

`/compact` ignores both. Setting `AGENC_DISABLE_COMPACT` without
`AGENC_DISABLE_AUTO_COMPACT` is the dangerous combination: mid-turn still
decides a compact is required, `autoCompactIfNeeded` returns
`wasCompacted: false`, and the turn dies with `mid_turn_compact_skipped`.

### Admitted summary calls

Every provider summary goes through `runAdmittedModelCall` with step id
`compact:<attemptId>:<callCount>`. That is a different namespace from streamed
model samples (`model:…`). The summary request currently omits `tools`.
`accountingOptionsForProvider` then copies constructor-scoped factory tools
onto the admitted request when `options.tools` is undefined. A large MCP or
builtin catalog can therefore deny the **summary** with
`context_window_exceeded` even though compaction exists to shrink the
window. Threshold estimates already include those factory tools
(`estimateMessagesTokens` in `_deps/runtime.ts`).

Accepted output is still strict `CompactionSummaryV1`. Shrink must save at
least **1,024** tokens and **20 percent**. Automatic compaction is suppressed
after **two** durable `compaction_failed` rows for the same
history/configuration digest; `/compact` (manual) is the explicit retry.

### Rollback and retention

Committed source spans stay rollback-eligible for at least seven days
(`COMPACTION_ROLLBACK_RETENTION_MS`). Operators:

```text
/compact-rollback <attempt-id>
/compact-rollback <attempt-id> --branch <target-session-id>
/compact-retain <attempt-id> --until <ISO-8601>
```

Same-session rollback is refused when later canonical work exists; `--branch`
keeps that work and materializes the restored history as the named session.
`/compact-retain` can only extend the deadline. Commands refuse during an
active turn.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Turn dies with `mid_turn_compact_failed` / `mid_turn_compact_skipped` | The outer gate fired and compact then skipped or threw. Check `AGENC_DISABLE_COMPACT`, the 3-strike counter, the 2-failure digest guard, and whether the 0.75 estimate disagreed with last-sample `promptTokens`. |
| Auto never fires, then the next turn is `context_window_exceeded` | Threshold is `min(window-13k, 75%)` because admission's margin-inflated total sits below `window-13k` on large catalogs. Confirm the live window (not the 128k fallback) and `AGENC_AUTOCOMPACT_PCT_OVERRIDE`. |
| `/compact` or auto fails `context_window_exceeded` on the summary itself | Factory tools were merged into the admitted summary. The transcript shrink cannot run until that request fits. |
| History vanished after a failed compact | Should not happen. Only a flushed `compaction_committed` replaces active history. If it did, that is a transaction bug — do not treat in-memory replacement as commit. |
| `/compact` says durable adapter unavailable | Compaction requires the canonical rollout owner (`readCompactionTransactionAdapter`). There is no character-extract fallback. |

Operator command syntax also lives in [cli.md](../../reference/cli.md#compaction-operator-commands).
Threshold vs admission accounting: [provider-aware-token-accounting.md](../provider-aware-token-accounting.md).
