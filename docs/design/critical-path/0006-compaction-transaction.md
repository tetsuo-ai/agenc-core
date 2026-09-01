# CP-0006: Make compaction a rollback-capable transaction

| Field | Value |
| --- | --- |
| Status | Shipped (0.14.0+). The [critical-path README](README.md) is authoritative. |
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
`compact.ts`, `transaction.ts`, `operator.ts`, `session/run-turn.ts`,
`session/session.ts`, `commands/session-compact.ts`,
`tui/components/Message.tsx`, `app-server/background-agent-runner.ts`,
and `budget/admitted-model-call.ts`.

### Entry points

| Path | Trigger | If it does not compact |
| --- | --- | --- |
| `/compact [focus]` | Manual. `querySource: "compact"`. Not gated by the disable env vars. | Error only. History stays as-is until a durable `compaction_committed`. |
| Model-downshift pre-turn | Next turn after a switch to a smaller-window model (`maybeRunPreviousModelInlineCompact`). The previous slug differs, the old window is larger, and usage is greater than the new pre-sampling limit or at least the new window. Compacts against the **previous** model's context. | No-op continues the turn. Thrown errors propagate (`propagateErrors: true`). |
| Pre-sampling auto | `autoCompactIfNeeded` when estimated tokens ≥ the safety threshold. | Increments `consecutiveFailures` on turn state even when tracking was never initialized. Three failures skip later autos this turn. User/provider abort does not count. |
| Mid-turn sampling loop | Last sample `promptTokens` is at least the mid-turn outer limit and the turn still needs follow-up (tools, mailbox, or `needsFollowUp`). | A thrown error or a no-op compact terminates this turn with event cause `mid_turn_compact_failed`. A no-op compact puts `mid_turn_compact_skipped` in the event message. |
| Post-tool follow-up | Last sample `promptTokens` is at least the same outer limit and tools still require follow-up. | The loop repeats only after a committed compact. A no-op result continues to the commit phase. |

Same-context callers serialize on a `WeakMap` (`compactConversation`). A
second `/compact` or mid-turn auto against the same `CompactContext` awaits
the in-flight result instead of writing a competing summary.

Agent-invocation envelope messages are never summarized. The kept suffix is
about 20 percent of history (min 1, max 4; empty when there are two or fewer
messages), then walked forward so a tool result is not kept without its
parent `tool_calls` message.

### Thresholds

For a context window above 13,000 tokens, `getAutoCompactThreshold` uses:

```text
min(window - 13_000, floor(window * 0.75))
```

For a context window at or below 13,000 tokens, it uses:

```text
min(floor(window * 0.8), floor(window * 0.75))
```

`window` is `AGENC_AUTO_COMPACT_WINDOW` (positive integer) if set, then the
live `CompactContext.options.contextWindowTokens`, then the model-string
fallback from `lookupContextWindowForModel`. That fallback uses 200k for
haiku, sonnet, and opus. For other models, it checks the OpenAI-compatible
table and uses 128k for an unknown model.

`AGENC_AUTOCOMPACT_PCT_OVERRIDE` is a percentage from `1` through `100`. It
can only make auto-compact run earlier than that default because it is capped
at the safety threshold.

Pre-sampling uses that threshold unless `modelInfo.autoCompactTokenLimit`
provides an explicit limit. Mid-turn and post-tool outer gates resolve
the limit through `getAutoCompactTokenLimit`. The helper uses
`modelInfo.autoCompactTokenLimit` when set. Otherwise it uses
`window - 13_000` for windows above 13,000 tokens and `window` for smaller
windows. Both
gates pass `force: true`, so `autoCompactIfNeeded` does not recheck the
threshold after the outer condition is met. They read the last
provider-reported `promptTokens`, not cumulative usage.

`runAutoCompact` writes `consecutiveFailures` onto turn state even when
`autoCompactTracking` was never initialized. `autoCompactIfNeeded` skips
when that count is already **3** (`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`).
The fourth automatic attempt in the same turn is therefore a no-op.

### Disable flags

Truthy values are `1`, `true`, `yes`, `on` (case-insensitive).

| Var | What it actually gates |
| --- | --- |
| `AGENC_DISABLE_AUTO_COMPACT` | Auto-compact plus the pre-sampling, mid-turn, and post-tool outer gates (`getPreSamplingAutoCompactTokenLimit` / `getAutoCompactTokenLimit`). It takes precedence even when `modelInfo.autoCompactTokenLimit` is set. |
| `AGENC_DISABLE_COMPACT` | `autoCompactIfNeeded` only. The mid-turn and post-tool outer gates do not consult it. |

`/compact` ignores both. If only `AGENC_DISABLE_COMPACT` is set, the mid-turn
outer gate can still require a compact. `autoCompactIfNeeded` then returns
`wasCompacted: false`. The sampling loop terminates the turn with event cause
`mid_turn_compact_failed` and a message that starts with
`mid_turn_compact_skipped`. That close is a `warning` plus `compact_failed`,
not run death. See [compact skip and session survival](#compact-skip-and-session-survival).
The post-tool checkpoint does not terminate on that no-op. It continues to
commit.

Model-downshift can still enter the dispatcher when usage is at the new
window even if `AGENC_DISABLE_AUTO_COMPACT` hid the pre-sampling limit.
`autoCompactIfNeeded` then returns without compacting, and the turn continues.

### Compact skip and session survival

Mid-turn skip-or-throw and pre-sampling throw emit a session `warning`
(causes `mid_turn_compact_failed` / `pre_sampling_compact_failed`) and
close the turn with `stopReason: "compact_failed"`. They do not emit
canonical `error`. Keep-alive daemon sessions stay promptable. The
daemon-backed `--print` / `--no-tui` path currently maps the resulting
`turn_complete` to exit code 0; the compatibility `runAgent` path with
`keepAlive: false` reports failure. `--autonomous` keepalive
blocks further ticks after `compact_failed` (same as hard `error`).

Pre-sampling no-op (`wasCompacted: false`) continues the turn. Mid-turn
no-op after the outer gate is met does not; that is the skip path
above. Post-tool no-op still continues to commit.

Legacy live `type: "error"` records are diagnostic regardless of cause.
`projectTelemetryErrorAsSessionOnly` in `background-agent-runner.ts` projects
them with `statusProjection: "session_only"`, so future diagnostic causes
cannot accidentally become lifecycle terminals. Operator mapping:
[daemon.md](../../reference/daemon.md#compact-skip-stays-per-turn).

### Admitted summary calls

Every provider summary goes through `runAdmittedModelCall` with step id
`compact:<attemptId>:<callCount>`. That is a different namespace from streamed
model samples (`model:...`). Summary calls set `tools: []` and
`toolRouting.allowedToolNames: []`. Constructor-scoped client tools are not
copied into the request, and the provider-native routing allowlist selects no
native tools. Admission derives its provider-native accounting catalog from
the same options that the wire adapter receives, so it accounts the same
selected native tools that can reach the provider.

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

A committed attempt is `compact-${randomUUID()}` (UUID v4). After
`compaction_committed` the ID is recoverable without digging the event log:

| Surface | What you see |
| --- | --- |
| `/compact` result | `formatCompactionOperatorDisplay` appends `Rollback attempt ID: <id>` to the command text. The in-process path and the daemon-backed TUI both do this. |
| TUI replacement-history boundary | `CompactBoundaryMessage` prints the same line under `✻ Conversation compacted`. It reads `compactionHistory` on the system message. |
| Daemon `session.partialCompactFromMessage` | Success includes optional `attemptId` and `displayText`. The runner forwards those fields after it broadcasts `history_replaced`. |

The TUI prints an ID only when the marker is `version: 1`, `kind: "boundary"`,
`summary_sha256` is 64 hex characters, and `attempt_id` matches UUID v4
`compact-...`. Auto-compact writes the same validated marker, so its
boundary also shows the ID. Reconstructed legacy rows use
`legacy-compacted:<sha256>` and stay hidden. Current compaction fails when the
canonical rollout owner or transaction adapter is unavailable. It does not
commit replacement history without a rollback ID.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Event cause is `mid_turn_compact_failed` and its message starts with `mid_turn_compact_skipped` | The outer condition was met and compact returned no committed result. Check `AGENC_DISABLE_COMPACT`, the 3-strike counter, and the 2-failure digest guard. The event is a `warning`; the turn stop is `compact_failed`. |
| Keep-alive session answers `no longer running (status: error)` after that warning | Unexpected after the warning remap. Confirm the event is `warning` (or a legacy `error` with `statusProjection: "session_only"`). The daemon-backed one-shot CLI exits 0 on the resulting `turn_complete`; the compatibility `runAgent` path fails. Autonomous keepalive ticks stop after `compact_failed` by design. See [daemon.md](../../reference/daemon.md#compact-skip-stays-per-turn). |
| Auto never runs, then the next turn is `context_window_exceeded` | Confirm the live window instead of assuming the 128k fallback. Above 13k, the threshold is `min(window-13k, 75%)`. Also check `AGENC_AUTOCOMPACT_PCT_OVERRIDE` and `AGENC_DISABLE_AUTO_COMPACT`. |
| After switching to a smaller-window model, the first turn overflows | Model-downshift only runs when the previous slug differs, the old window is larger, and usage is greater than the new pre-sampling limit or at least the new window. Three failed automatic attempts skip later ones this turn. `AGENC_DISABLE_AUTO_COMPACT` makes the compact return without changing history. |
| A summary call includes a client or provider-native tool | This violates the summary-call contract. Summary calls must send an empty client catalog and an empty native-tool routing allowlist. Admission must account the same selected native catalog as the wire. |
| History vanished after a failed compact | Only a flushed `compaction_committed` may replace active history. Any earlier replacement is a transaction bug and must not be treated as a commit. |
| `/compact` says durable adapter unavailable | Compaction requires the canonical rollout owner (`readCompactionTransactionAdapter`). There is no character-extract fallback. |
| Compacted, but no rollback attempt ID in the TUI | Confirm a flushed `compaction_committed`. The TUI only prints UUID v4 `compact-...` IDs from a validated `kind: "boundary"` marker. Legacy `legacy-compacted:` reconstructions stay hidden. Recheck the `/compact` result text or the daemon `attemptId` field. |

Operator command syntax also lives in [cli.md](../../reference/cli.md#compaction-operator-commands).
Threshold vs admission accounting: [provider-aware-token-accounting.md](../provider-aware-token-accounting.md).
