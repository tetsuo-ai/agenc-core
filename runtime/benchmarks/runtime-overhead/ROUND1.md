# AgenC runtime fast path evidence

Measured 2026-09-29 on the Linux benchmark PC. The isolated runtime changes reduce warm inter-call overhead by 55.5%, from 149.7 to 66.6 ms. Warm runtime outside tools drops 33.9%, from 3.82 to 2.53 s/task; cold runtime outside tools drops 32.6%, from 4.91 to 3.31 s/task. The combined 50 ms warm target remains unmet.

## Why

Canonical rollout commits synchronously rebuilt a derived SQLite thread/history index. Long tool results magnified that work before the next model call. The loop also durably emitted the same complete iteration checkpoint again at its next admission boundary. Both costs were visible in opt-in timing spans before changing behavior.

## What changed

- Coalesce derived thread-index notifications for up to 250 ms. Explicit thread reads, flushes, unbind and close catch up pending projections. Failed projections stay pending for retry. Recovery reconstructs the index from the canonical rollout.
- Reuse only an exactly identical, already committed checkpoint within one running turn. Identity includes boundary, iteration, durable prefix hash and count, versions, and the entire resumable state. Failed emits are not cached; recovery starts with an empty cache. New model ordinals still require their canonical checkpoint before admission.
- Add opt-in, buffered, payload-free spans with `AGENC_RUNTIME_TIMING=/absolute/task-owned/path/timing`. Disabled instrumentation performs no timing clock reads, scheduling or writes. Diagnostic failures cannot fail runtime work.

## Method and provenance

- Base: `origin/main` pinned to `46b2a5dbff45d9010bee965ddc5bad150d2f8bed`. The baseline is this source plus instrumentation only. Decompress and apply the adjacent `baseline-instrumentation.patch.gz` to reproduce its production source; it contains neither optimization.
- Measured candidate: `948e9f862aaac9f492772624484346bc36aa2904`; production `runtime/src` tree `d27b590e1d1ab47933750559e050da2287c0ebc4`. Later changes are benchmark analysis, tests, env documentation, evidence and blank-line whitespace cleanup only. The final integration commit is recorded in the task root STATUS.md.
- Node 26.5.0, Linux, task-owned containers limited to 2 CPUs and 4 GiB, host UID. Full test suites finished before primary measurement. Shared-host scheduling and storage noise remain possible. One repeat per task/mode/variant, with variant order alternating across tasks.
- Primary cohort: recorded Flash sequences for tasks 03, 07 and 09 from `light-ultra/runs/candidate-round2-new-deepseek-flash-*-light-r1`; task 12 uses `candidate-round2-confirm-screen-deepseek-flash-12-partition-map-light-r1`. Source trees and traces were read only.
- A local OpenAI-compatible SSE server serves recorded assistant content, reasoning and tool calls without upstream access, artificial delay or model spend. Real tool commands run against fresh task repositories. Recorded repository paths and live process handles are remapped. Only commands followed by a recorded poll use a 1 ms yield so the poll remains meaningful without model think time. Adjusted calls and source hashes are in evidence.json.
- Cold includes CLI startup, daemon autostart, session creation, task and session teardown. Warm starts the daemon before the timed new-session CLI invocation. This models daemon reuse, but still includes a CLI client startup that the Desktop app does not need. External daemon stop is reported separately.
- Primary inter-call overhead is server response-flush to next request, minus the union of tool.invoke intervals. It includes pre-tool and post-tool work and gaps between tools. There are 63 requests and 59 inter-call gaps per variant/mode. Tool.invoke includes permission/sandbox/dispatch wrappers and real tool execution. It is not pure child-process time. Runtime outside tools is task wall minus the tool interval union.
- Every one of the 16 primary and 4 supporting runs has matching recorded call counts, no replay mapping errors, successful CLI/daemon stop, and a passing task checker. Before/after pairs have identical trace and harness hashes. Early exploratory runs with suite overlap or pre-correction replay behavior are excluded.
- Adjacent evidence.json contains summaries and per-run data; raw payload-free timing files and wire boundaries remain under `~/claude-agenc-work/light-runtime/replay-runs/` on the PC. Replay harness SHA-256: `73981f01e4b35d4c0b47904733655c80d7c74b311e602079d5e6cc2c3ab8948d`.

## Before and after

All following span times are milliseconds per task, averaged over four tasks. Spans are inclusive and nested; do not add rows. The separately labelled post-tool partition below is exclusive.

| Span / metric | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| Task wall | 10040.8 | 8238.3 | 8701.5 | 7524.0 |
| Runtime outside tools | 4911.2 | 3311.3 | 3821.7 | 2526.5 |
| Daemon start/readiness | 802.8 | 813.7 | 11.6 | 11.1 |
| Session create | 909.4 | 798.8 | 873.0 | 829.5 |
| First request assembly | 15.4 | 12.0 | 13.6 | 13.6 |
| All prompt assembly | 99.8 | 93.4 | 141.3 | 111.8 |
| Provider API request spans | 154.5 | 112.2 | 107.0 | 95.4 |
| Response end to tool start | 785.1 | 349.2 | 855.6 | 342.8 |
| Tool invoke, sum | 5130.8 | 4928.1 | 4881.0 | 4998.5 |
| Gaps between tools | 287.0 | 88.5 | 279.2 | 91.4 |
| Last tool end to next request | 1139.1 | 536.7 | 1073.5 | 547.7 |
| Model admission | 457.8 | 169.0 | 444.5 | 165.9 |
| Tool admission | 302.2 | 97.4 | 323.3 | 98.6 |
| Receipt commit/projection | 285.7 | 86.1 | 285.2 | 90.8 |
| History synchronization | 47.3 | 26.9 | 50.8 | 26.9 |
| Iteration commit phase | 1.4 | 1.5 | 1.4 | 1.4 |
| Rollout flush, including callback | 1267.3 | 246.7 | 1206.8 | 252.5 |
| Explicit rollout fsync | 562.2 | 219.3 | 534.5 | 225.5 |
| SQLite immediate transaction | 1219.1 | 285.0 | 1177.7 | 289.2 |
| SQLite transaction | 27.7 | 14.3 | 27.0 | 13.2 |
| Derived thread index | 682.3 | 21.5 | 649.4 | 23.5 |
| Rollout byte-offset index | 5.2 | 1.7 | 2.9 | 2.3 |
| Atomic rollout rewrite | 5.0 | 1.5 | 2.7 | 2.1 |
| Other synchronous atomic write | 20.6 | 8.7 | 7.7 | 12.1 |
| Session teardown | 77.6 | 50.9 | 54.8 | 56.9 |
| External daemon stop | 589.6 | 602.1 | 589.5 | 614.6 |
| Explicit rollout fsync count | 278.0 | 263.2 | 278.0 | 263.2 |
| Rollout bytes written | 351,284.0 | 342,318.8 | 351,809.0 | 342,169.8 |

Cold task wall including external daemon stop: 10.63 -> 8.84 s. Daemon startup and external stop themselves were not materially improved. The cold reduction comes mainly from less work inside the task.

| Per-call metric | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| Mean boundary overhead, ms | 149.9 | 66.1 | 149.7 | 66.6 |
| p95 boundary overhead, ms | 468.1 | 94.4 | 478.5 | 93.6 |

Warm aggregate components per inter-call gap: pre-tool 58.0 -> 23.2 ms; between tools 18.9 -> 6.2 ms; post-tool 72.8 -> 37.1 ms. The combined 66.6 ms result is 16.6 ms above target. Remaining post-tool costs include authoritative SQLite transactions and fsync, prompt assembly, and unclassified transport/control work. This change does not relax those barriers to reach the target.

### Exclusive post-tool partition

Each row is clipped to the last tool end through the next request. Nested fsync/SQLite spans take precedence over enclosing admission/receipt spans. Other includes transport, event-loop scheduling, and work without a narrower span. Time rows add to the measured post-tool total.

| Post-tool component | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| fsync | 241.5 | 90.0 | 212.9 | 91.5 |
| sqlite | 512.9 | 118.6 | 479.7 | 125.6 |
| derived index | 9.8 | 1.2 | 9.6 | 2.0 |
| receipts | 3.2 | 3.2 | 3.2 | 3.3 |
| prompt assembly | 84.4 | 79.4 | 127.6 | 95.6 |
| persistence other | 17.9 | 15.5 | 18.1 | 15.9 |
| admission | 37.5 | 36.4 | 37.6 | 36.4 |
| other | 231.9 | 192.4 | 184.6 | 177.3 |
| fsync count | 118.0 | 103.2 | 118.0 | 103.2 |
| written bytes | 162,048.0 | 153,353.5 | 162,493.8 | 153,348.2 |

### Tool time by tool

Inclusive admitted dispatch times, milliseconds per task. Real command runtimes can vary independently of runtime overhead.

| Tool | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| FileRead | 26.8 | 14.3 | 25.0 | 15.4 |
| MultiEdit | 18.5 | 13.2 | 20.6 | 12.2 |
| TodoWrite | 5.6 | 4.9 | 5.7 | 4.1 |
| Write | 64.0 | 55.1 | 61.3 | 55.5 |
| exec_command | 3057.4 | 2799.8 | 2826.6 | 2908.9 |
| write_stdin | 1958.6 | 2040.9 | 1941.9 | 2002.5 |

### Warm result by task

| Task | Requests | Boundary ms before | Boundary ms after | Runtime outside tools before, s | After, s |
|---|---:|---:|---:|---:|---:|
| 03-window-padding | 16 | 360.9 | 75.6 | 7.274 | 2.774 |
| 07-source-manifest | 14 | 77.0 | 62.6 | 2.493 | 2.266 |
| 09-separator-payload | 14 | 68.9 | 57.8 | 2.391 | 2.298 |
| 12-partition-map | 19 | 84.6 | 68.2 | 3.128 | 2.768 |

Task 03 accounts for much of the aggregate gain. The independent light-port task09 sequence, 12 requests, also passes and improves warm boundary overhead 86.2 -> 66.3 ms and task wall 2.968 -> 2.718 s. These are small samples, not confidence intervals or proof of superiority on every model.

### Native durability diagnostic

Separate warm task09 replay, 14 requests, using the forwarding Linux syscall preload. Counts include AgenC daemon/client SQLite and directory synchronization, exclude diagnostic writes, and are not used for primary wall-time claims. The diagnostic daemon runs in the foreground because normal autostart correctly sanitizes LD_PRELOAD.

| Metric | Before | After |
|---|---:|---:|
| fsync + fdatasync calls | 765 | 521 |
| Successful regular-file write bytes | 32,407,225 | 16,101,797 |
| Explicit rollout fsync calls | 224 | 211 |

No canonical commit-before-effect barrier was removed. The large write reduction comes from coalescing derived projections; the 13 fewer explicit rollout syncs correspond to duplicate checkpoints.

## Real Flash check

The main job’s frozen harness was copied unchanged (43 files, all hashes match). One repeat each of tasks 03, 07, 09 and 12, DeepSeek Flash, one worker, $2 cap, $10 balance floor. Pre-task balances ranged from $27.58 to $27.68. Recorded list-rate spend was $0.048834084, with 101 model calls, complete usage, zero provider errors and no budget stops. The key was read from the specified export and sent only through SSH stdin into the harness process environment.

| Task | Coding checker | Full harness | Wall, s | Provider, s | Tool + runtime, s | Calls | Cost, USD |
|---|---|---|---:|---:|---:|---:|---:|
| 03-window-padding | pass | pass | 105.606 | 84.888 | 20.718 | 24 | 0.013179 |
| 07-source-manifest | pass | pass | 63.117 | 57.440 | 5.677 | 19 | 0.009445 |
| 09-separator-payload | pass | pass | 76.512 | 63.584 | 12.929 | 19 | 0.009683 |
| 12-partition-map | pass | fail | 139.766 | 103.053 | 36.712 | 39 | 0.016527 |

Task 12 exits successfully and passes its coding checker, but the frozen harness rejects its deferred-tool capability evidence: both `plan_call_success` and `discovery_success` are false. Overall result: 3/4 full harness passes, 4/4 coding checks. No additional paid run was made. This branch does not include the other job’s prompt/tool/request-layout changes.

This live check does not establish a wall-time improvement: it made 101 model calls versus 63 in the recorded replay and executed different tools. Provider timing comes from the frozen proxy; the residual includes real tools and AgenC runtime. The controlled before/after evidence is the identical-sequence local replay, not a comparison of these live walls with older model runs.

Exact-key scans after the check found zero matches in 6,187 local task files and 28,788 PC task/results files. Scans print counts only, never matching values. Authored-file pattern scans are repeated after the final artifacts are written.

## Tests

- Core source and test-support typecheck pass with local Node 26.8.1.
- Final official Linux affected-file run: 14 files passed, 351 tests passed, one existing skip (`light-runtime-final-focus`). Covers admission, diagnostics, thread store, run-turn, session store, compaction/recovery/shutdown and env documentation.
- Full official Linux runner on main: 2683 passed files, 35 failed, one skipped; 32638 passed tests, 83 failed, 11 skipped. Candidate broad run: 2681 passed files, 39 failed, one skipped; 32637 passed tests, 92 failed, 11 skipped. These shared-host broad runs were not green.
- Every candidate-only failing file was rerun alone. Two reproducible new failures were the missing env documentation row, now fixed and passing in the final focus run. Daemon CLI (163), workflow permissions (8), SIGKILL durability matrix (15), fault harness (47), plugin settings (61), and compaction tool pairs (4) pass alone. Provider credential authority had a different isolated failure; subsequent paired standalone main and candidate runs both pass 76/76. No reproducible new failure remains. See test-evidence.json for actual runner exit codes; the runner shell wrapper itself is not a test success signal.
- New tests verify durable canonical append before deferred projection, one coalesced transaction, read/flush/close catch-up, failed projection retry, recovery from an unprojected durable tail, and reuse of only an identical checkpoint before the next model request. Existing actual kernel/effect restart and the 15-case SIGKILL matrix pass.
- Local focused admission/diagnostic tests: 84 pass. Recovery/store/compaction: 88 pass. Run-turn: 139 pass, 11 platform skips. Replay and interval accounting Python tests: 6 pass.
- Only whitespace on blank lines was cleaned up after measured revision 948e9f862; production behavior is identical. The broad candidate run used 6ccb422b8; subsequent source edits added span correlation/error-path timing. The final affected-file run used that final production source plus the env docs fix.

## Not changed and limits

Permission admission, sandbox behavior, canonical effect intents and receipts, commit-before-effect ordering, SQLite FULL synchronization, and recovery authority are unchanged. The benchmark uses the existing harness approval/sandbox bypass to execute its fixtures; production enforcement is covered by the admission and recovery tests. No new read-only tool parallelism, general fsync batching, prompt caching, prompt content, tool presentation, request layout, model settings, or billing behavior was introduced.

The derived index can lag by up to its scheduled 250 ms between explicit catch-up operations; it is reconstructible and does not guard effects. Timing logs are best effort and may lose buffered records on crash. Native diagnostic counts require Linux. Warm replay still includes new-session/client overhead. The branch has not been merged, released or deployed, and the separate light/converged worktree was not edited.
