# Runtime fast path, Round 3

Draft PR: https://github.com/tetsuo-ai/agenc-core/pull/2821

Round 3 retains the durability barriers and removes unnecessary writer transactions from read-only admission queries. Warm SDK runtime outside tools is **1.21 -> 1.03 s/task**; inter-call overhead is **65.3 -> 56.6 ms** in this matched run. The 1.0 s/task and 40 ms targets remain unmet. No model spend.

## What changed

- `state/execution-admission.ts`: `get` and `list` retain consistent multi-query snapshots using deferred read transactions. Four single-statement read APIs use SQLite's statement snapshot directly. None reserves the WAL writer slot. All mutation, reservation, dispatch, deadline/cancellation and accounting checks remain inside their existing immediate transactions with FULL sync.
- `tests/state/execution-admission.test.ts`: a second connection holds an uncommitted write while all six changed read APIs return committed data without blocking. The next read observes that write only after commit.
- `tests/session/admission-group-commit.test.ts`: new provider-wire and tool-effect cases inject canonical fsync failure, prove zero publication and zero physical dispatch, and retry with a durable tail repair and exactly one dispatch record.
- `benchmarks/runtime-overhead/summarize.py` and its tests: immediate/deferred transaction counts and per-call rates; exclusive pre-tool attribution; actual fsync counts classified by the innermost flush boundary. Empty and append-only flush attempts are not misreported as durable flushes.

## Boundary limit and stopped work

The exact retained guarantee is **a durable admission grant or effect acknowledgement cannot become observable before its canonical record is fsynced; physical dispatch additionally requires the final cancellation/deadline check and dispatch record to commit**.

The current contracts contain more acknowledgement boundaries than just model requests and effect batches:

1. `acquire()` durably grants a reservation and publishes it before returning. A tool's permission/sandbox work can then await before physical dispatch.
2. Effect intent commits and is published before invoking the adapter. `markDispatched()` later linearizes the final cancellation/deadline check under the authoritative SQLite writer lock, commits the dispatch evidence, and synchronously flushes the canonical projection before crossing the physical boundary.
3. Effect results commit before publication or caller continuation. Admission reconciliation also commits and publishes its journal/usage before returning. Checkpoint events have their own durable-before-publication contract.

Buffering all those records until just the next request or effect would publish acknowledged evidence before durability, or acknowledge/release accounting capacity before settlement is committed. Marking dispatch at reservation time would misclassify cancellation during permission/sandbox awaits and weaken the final dispatch check. Moving effect and in-flight state off-path would weaken the unknown-outcome gate. Those deferrals were not made. Reaching two flushes would require a new cross-owner prepare/commit/publication protocol, with explicit rollback and recovery semantics, not simply a flush timer. This round stops at those guarantees; it does not claim the performance targets are fundamentally impossible under a future protocol.

No durable flushes were removed in Round 3, so the existing SIGKILL matrix continues to test the same boundaries. The new failure/retry case at each dispatch boundary adds coverage for the exact fail-closed rule. No derived table was moved off-path, and prompt assembly was not changed. This is a partial improvement and boundary audit, not completion of the requested batching redesign.

## Measurement

Same zero-cost replay and four recorded tasks 03/07/09/12, one repeat, alternating before/after order; cold, resident-daemon CLI and existing SDK connection. All 24 runs preserve recorded call counts, have no replay mapping errors, and pass coding checks. All task results and trace hashes are retained in `round3-evidence.json`. Existing SDK session priming and CLI startup are excluded from the primary number, as in Round 2. Real tools run locally; tool.invoke interval unions are subtracted. Shared-host storage variation remains, and a single repeat is not a confidence interval. Fsync durations fell despite identical counts, and the unchanged receipt path also became faster; the full observed timing difference cannot be attributed to the read-lock change. The reliable structural result is the reduction in read-side writer transactions. Do not compare this run causally with Round 2's older 1.57 s / 89 ms window.

Before is Round 2 `025d23295`. After replay records that base plus `r3-source.patch`; its only production edit matches Git blob `940a47292e33de21e83af64cb6e4d2cb42b4790d` on both machines. Linux validation uses `e6d260717`, with production tree `18bd634c6f8109b60892cf72c1eda530a50c378e`. Final documentation/evidence amendment leaves that source unchanged. STATUS.md names the final integration commit. The original main comparison is retained in ROUND1.md, and Round 2 in ROUND2.md.

## Span table

Milliseconds per task unless labelled count. Inclusive rows overlap. Cold/CLI creation and teardown are instrumented session spans; SDK uses RPC timings. Transaction counts count instrumented top-level calls, not SQLite fsync syscalls. Removing read transactions must not be described as eliminating durable commits.

| Metric | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| Task wall | 6,252.9 | 6,151.6 | 7,874.9 | 8,127.0 | 7,312.2 | 7,236.9 |
| Runtime outside tools | 1,205.2 | 1,025.6 | 2,992.7 | 2,950.2 | 2,208.4 | 2,173.1 |
| Session create | 110.1 | 73.2 | 656.2 | 636.2 | 646.3 | 621.8 |
| First request assembly | 8.7 | 8.4 | 8.3 | 9.3 | 8.7 | 8.8 |
| All prompt assembly | 92.2 | 98.6 | 104.4 | 103.0 | 103.8 | 104.1 |
| Response end to tool start | 333.4 | 287.1 | 294.4 | 295.8 | 304.5 | 294.5 |
| Gaps between tools | 113.9 | 76.2 | 79.4 | 81.5 | 76.9 | 82.4 |
| Last tool end to next request | 515.9 | 472.1 | 484.2 | 479.4 | 489.6 | 486.4 |
| Model admission | 136.8 | 115.4 | 116.0 | 116.2 | 117.6 | 114.6 |
| Tool admission | 69.2 | 53.3 | 55.3 | 55.5 | 56.3 | 56.2 |
| Receipt commit/projection | 108.5 | 82.8 | 84.7 | 86.7 | 84.2 | 92.6 |
| History sync | 29.8 | 25.8 | 26.8 | 26.5 | 26.5 | 26.6 |
| Rollout flush | 233.7 | 179.8 | 185.8 | 185.6 | 184.3 | 186.7 |
| Explicit rollout fsync | 212.7 | 156.9 | 162.4 | 162.2 | 159.2 | 163.2 |
| SQLite immediate transaction | 297.4 | 229.7 | 241.4 | 234.8 | 246.3 | 241.6 |
| SQLite deferred transaction | 15.3 | 14.8 | 15.5 | 16.1 | 15.4 | 15.0 |
| SQLite immediate count | 398.2 | 209.8 | 403.8 | 211.8 | 398.0 | 209.8 |
| SQLite deferred count | 239.8 | 240.0 | 242.0 | 245.0 | 239.2 | 240.0 |
| Explicit rollout fsync count | 194.8 | 194.8 | 194.8 | 194.8 | 194.8 | 194.8 |
| Session teardown | 45.2 | 45.8 | 53.4 | 51.6 | 54.1 | 53.3 |
| Mean inter-call overhead | 65.3 | 56.6 | 58.2 | 58.1 | 59.0 | 58.5 |
| p95 inter-call overhead | 124.5 | 85.7 | 83.0 | 83.8 | 86.7 | 86.7 |

## Immediate transactions and explicit fsyncs per call

| Mode | Immediate before | Immediate after | Fsync before | Fsync after |
|---|---:|---:|---:|---:|
| daemon | 25.29 | 13.32 | 12.37 | 12.37 |
| cold | 25.63 | 13.44 | 12.37 | 12.37 |
| warm | 25.27 | 13.32 | 12.37 | 12.37 |

## Exclusive last-tool to request breakdown

Milliseconds per task; rows sum to the corresponding interval. Inner fsync/SQLite takes precedence over receipts and admission.

| Metric | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| fsync | 71.5 | 62.0 | 63.8 | 64.0 | 63.0 | 64.1 |
| sqlite | 117.4 | 96.6 | 100.0 | 96.9 | 102.1 | 104.4 |
| derived_index | 1.1 | 0.8 | 1.3 | 1.0 | 2.0 | 1.8 |
| receipts | 3.2 | 3.3 | 3.1 | 3.2 | 3.5 | 2.9 |
| prompt_assembly | 80.1 | 88.1 | 95.5 | 91.9 | 93.2 | 91.1 |
| persistence_other | 15.2 | 14.0 | 14.1 | 13.7 | 14.6 | 14.0 |
| admission | 36.1 | 35.0 | 34.2 | 34.8 | 35.0 | 35.0 |
| other | 191.4 | 172.3 | 172.1 | 173.9 | 176.1 | 173.0 |

## Exclusive response to first-tool breakdown

Milliseconds per task; rows sum to the corresponding interval. Inner fsync/SQLite takes precedence over receipts and admission.

| Metric | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| fsync | 62.7 | 45.7 | 48.5 | 47.5 | 49.0 | 48.5 |
| sqlite | 80.4 | 66.4 | 69.8 | 67.4 | 72.6 | 68.3 |
| derived_index | 0.8 | 0.7 | 1.0 | 0.9 | 0.0 | 0.3 |
| receipts | 2.1 | 2.0 | 2.0 | 2.1 | 2.2 | 2.0 |
| prompt_assembly | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| persistence_other | 8.2 | 7.8 | 8.0 | 8.0 | 8.5 | 8.3 |
| admission | 1.5 | 1.9 | 1.4 | 2.0 | 1.6 | 1.9 |
| other | 177.8 | 162.5 | 163.6 | 167.9 | 170.5 | 165.2 |

## Actual explicit fsyncs by boundary

Warm SDK mean counts per task, counting only actual fsync spans. Admission groups whose last record is usage are labelled `session_usage`.

| Boundary | Before | After |
|---|---:|---:|
| effect_intent | 21.25 | 21.25 |
| effect_result | 21.25 | 21.25 |
| execution_admission | 79.50 | 79.50 |
| outside_flush | 5.00 | 5.00 |
| plan_started | 0.75 | 0.75 |
| run_runtime_settings_changed | 1.00 | 1.00 |
| run_terminal | 1.00 | 1.00 |
| session_state | 2.00 | 2.00 |
| session_usage | 32.50 | 32.50 |
| turn_checkpoint | 29.50 | 29.50 |
| turn_complete | 1.00 | 1.00 |

## Individual SDK samples

The aggregate gain is concentrated in task03, whose baseline storage spans were slower. Tasks07 and09 are essentially unchanged; this limits the causal timing claim.

| Task | Calls | Runtime before, ms | Runtime after, ms | Gap before, ms | Gap after, ms |
|---|---:|---:|---:|---:|---:|
| 03-window-padding | 16 | 1906.5 | 1208.8 | 96.6 | 64.4 |
| 07-source-manifest | 14 | 873.8 | 886.1 | 54.3 | 54.7 |
| 09-separator-payload | 14 | 771.5 | 780.6 | 46.1 | 46.6 |
| 12-partition-map | 19 | 1269.1 | 1227.1 | 61.0 | 58.7 |

## Tests

Validation source: `e6d260717cf9e9e3f1c3defe5a0fc8c7d7102f78`, production tree `18bd634c6f8109b60892cf72c1eda530a50c378e`. Focused Linux suite: 382 passed, 1 skipped, exit 0. Full Linux suite: 32,650 passed, 87 failed, 11 skipped; 2,688 files passed, 33 failed, 1 skipped; exit 1 at 2026-09-29 22:22:51 UTC. All eight isolated triage files passed (281 tests total), completing at 22:26:47 UTC. These failures did not reproduce in isolation; the full-suite failures remain part of the result and this is not a green full-suite verdict. Collected evidence is retained at `/private/tmp/light-takeover/r3-test-evidence.json`. No completed suite was restarted during takeover.

No permissions, sandbox, effect receipts, recovery policy, provider requests, prompts or tool presentation changed. No edits to light/converged, no real provider calls, no deployment or merge.
