# Runtime fast path, Round 2

Draft PR: https://github.com/tetsuo-ai/agenc-core/pull/2821

Round 2 reduces resident-daemon SDK runtime outside tools from **2.20 to 1.57 s/task** and mean inter-call overhead from **116 to 89 ms**. New-session creation drops from **307 to 97 ms** on the same warm connection. The session-create mean meets the 100 ms target. The 1.0 s/task and 40 ms inter-call targets remain unmet. No Round 2 model spend.

## Changes and guarantees

- `bin/bootstrap.ts`: payload-free opt-in spans split shell, config, authority, permissions, auth, roles, registry, provider, model metadata, instructions, services, session mount and sidecars.
- `llm/models-manager.ts`: resolve only the selected model during bootstrap; construct and cache the full picker catalog on its first use. `llm/model-metadata.ts`: share public OpenRouter catalog requests through the existing TTL cache. Failed requests and credentials are not cached.
- `config/runtime-state-repository.ts`: preserve identity when a namespace updater returns its unchanged fresh snapshot. Persisted bypass consent no longer rewrites identical authority bytes. The existing disk authority lock and fresh read remain, including externally revoked consent.
- `state/execution-admission.ts` and `budget/execution-admission-kernel.ts`: combine enqueue and reservation into one SQLite immediate transaction when capacity is available and the queue is empty. Contention, legacy critical listeners and reentrant acquisition retain the scheduler. Cancellation/deadline checks remain authoritative.
- `budget/admission-client.ts`, `session/execution-admission-journal.ts`, `session/session.ts`, `session/session-store.ts`, `session/rollout-store.ts`: one canonical fsync for each committed admission group and its changed usage snapshot. SQLite commits first; canonical flush completes before publication, grant or physical dispatch. Failed sync denies progress, and retry reconciles existing canonical identities.
- `session/event-log.ts`: queue all committed batch events before delivering callbacks, preserving order through reentrant publication. `state/sqlite-driver.ts`: omit nested savepoint timing to avoid double counting enclosing transactions.
- New group-commit tests use a real kernel and rollout store, inject sync failure, verify no grant/publication, retry the same reservation, and check durable-before-publication ordering. Updated SIGKILL fixtures exercise the grouped production path. Before-reservation crashes now roll back the entire unacknowledged queue/reservation transaction.
- SDK replay over one existing connection excludes client process startup and separately reports a model-free priming session. CLI cold and resident-daemon CLI remain secondary measurements.

No FULL-sync setting, permission check, sandbox behavior, effect receipt, unknown-outcome gate, model request content, tool presentation or prompt layout was relaxed. The recovery-state writes found by profiling remain synchronous. No edits were made to light/converged or its worktrees.

## Measurement

- Before: Round 1 `fcb24b1a0e251393b259e47a16aa747e813af44d`. After: `36751015fdf7c4e2b45506f131d5025be7bcfbcc`. Measured production tree (`runtime/src`): `1ab0cb592a9ce3b684e05228022d6f2cf524d589`. Final documentation/evidence changes do not alter production behavior. STATUS.md names the final integration tip.
- Same recorded tasks 03/07/09/12, real tools, local zero-latency OpenAI-compatible SSE replay, one repeat, alternating before/after order by task. Node 26.5.0 containers, 2 CPU limit, 4 GiB, fresh task-owned homes and repositories. Source benchmark traces mounted read only.
- All 24 runs preserve recorded call counts, pass coding checks, and have no mapping error. Each mode/side has 63 model calls and 59 inter-call gaps. No upstream provider calls.
- Primary `daemon` mode connects, runs and stops one model-free session to prime the process, then times create + attach + turn + stop over that same SDK connection. It uses the daemon RPC path used by clients; this is not a Desktop UI benchmark. Priming and connection/import cost are excluded and reported separately. Mean priming: 954 ms before, 765 ms after. This measures a warm daemon and already-used workspace, not an untouched workspace.
- Secondary `warm` mode starts the daemon before the CLI invocation but does not prime a session. It includes CLI startup and first-session metadata. `cold` includes daemon autostart. External daemon stop is separate in all modes.
- Inter-call overhead is scripted-server response flush through the next request, less the union of tool.invoke intervals. Runtime outside tools is task wall less tool interval union. Tool.invoke includes tool wrappers, permission/sandbox dispatch and real work, so this is not pure child-process subtraction.
- Own full suite started only after this matched replay completed. Shared-host storage latency still varied sharply: Round 1 task07 CLI-warm runtime was 15.52 s, versus 2.78/3.19/3.93 s for its other tasks. Every sample is retained. The CLI aggregate is noisy and is not a reliable estimate of causal gain. Old Round 1 numbers are in ROUND1.md and must not be compared causally to a different host-load window.
- Replay SHA-256: `0abcbec46ff1a84cb5ff8ad47358257981ecede1794ff06c9357e4f816bb3635`; SDK harness SHA-256: `0aed4edb6845362c259f24beb2eec455ee0e12361ff82565b5a4bd259ba24719`. Per-run trace hashes, wire timestamps and outcomes are in round2-evidence.json. Raw spans: PC `~/claude-agenc-work/light-runtime/replay-runs/r2-paired-*`.

## Span table

Milliseconds per task, four tasks per mode/variant. Inclusive spans overlap; do not add them. SDK creation/teardown below uses RPC timings, whereas CLI modes use runtime spans.

| Metric | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| Task wall | 7,519.4 | 6,790.1 | 9,088.2 | 8,913.2 | 11,705.1 | 7,799.6 |
| Runtime outside tools | 2,202.0 | 1,570.2 | 4,012.6 | 3,680.6 | 6,354.7 | 2,738.8 |
| Daemon readiness | n/a | n/a | 864.8 | 852.0 | 10.9 | 11.2 |
| Session create | 307.3 | 97.3 | 870.5 | 647.5 | 978.4 | 792.7 |
| First request assembly | 8.8 | 8.9 | 11.6 | 9.1 | 13.6 | 8.7 |
| All prompt assembly | 152.0 | 143.1 | 147.3 | 154.1 | 305.1 | 142.4 |
| Response end to tool start | 622.4 | 463.7 | 568.7 | 505.3 | 1,761.0 | 428.6 |
| Gaps between tools | 215.4 | 132.7 | 174.0 | 194.2 | 761.5 | 138.3 |
| Last tool end to next request | 875.7 | 716.6 | 804.2 | 758.4 | 2,054.4 | 664.6 |
| Model admission | 325.7 | 193.5 | 295.7 | 203.9 | 828.0 | 175.3 |
| Tool admission | 231.5 | 101.2 | 196.5 | 117.1 | 637.6 | 94.2 |
| Receipt commit/projection | 214.0 | 168.1 | 182.8 | 222.2 | 678.3 | 163.2 |
| History sync | 58.0 | 49.8 | 51.6 | 55.1 | 158.6 | 46.2 |
| Rollout flush | 628.7 | 385.0 | 536.8 | 462.6 | 1,817.9 | 358.1 |
| Explicit rollout fsync | 608.2 | 364.9 | 511.8 | 440.4 | 1,793.8 | 337.7 |
| SQLite immediate transaction | 663.7 | 467.1 | 566.9 | 543.8 | 2,027.4 | 435.8 |
| SQLite transaction | 14.4 | 16.1 | 15.1 | 16.9 | 17.2 | 15.6 |
| Derived thread index | 44.3 | 35.4 | 38.3 | 39.9 | 282.2 | 34.3 |
| Session teardown | 69.7 | 65.7 | 48.3 | 66.3 | 77.6 | 63.2 |
| External daemon stop | 614.5 | 614.5 | 614.6 | 614.4 | 614.4 | 614.5 |
| Explicit rollout fsync count | 263.2 | 194.8 | 263.2 | 194.8 | 263.2 | 194.8 |
| Rollout bytes written | 342,742.8 | 342,402.0 | 342,193.0 | 342,287.8 | 341,079.0 | 342,731.8 |
| Mean inter-call overhead | 116.2 | 89.0 | 104.9 | 98.8 | 310.3 | 83.5 |
| p95 inter-call overhead | 187.1 | 134.1 | 177.7 | 198.8 | 1,428.0 | 136.1 |

## Exclusive post-tool breakdown

Clipped from the last tool end to the next request. Inner fsync/SQLite operations take precedence, so these time rows add to the post-tool interval. Unclassified work includes event delivery, transport, scheduling and recovery-state autocommit writes without their own span.

| Component | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| fsync | 237.2 | 143.2 | 204.6 | 164.4 | 708.0 | 130.2 |
| sqlite | 268.0 | 199.7 | 237.2 | 219.1 | 805.3 | 183.8 |
| derived_index | 1.7 | 1.7 | 1.2 | 1.5 | 2.3 | 1.7 |
| receipts | 3.1 | 3.0 | 3.1 | 3.2 | 3.3 | 3.3 |
| prompt_assembly | 134.5 | 123.5 | 128.4 | 138.9 | 235.5 | 123.4 |
| persistence_other | 16.6 | 15.1 | 16.1 | 14.8 | 39.5 | 14.4 |
| admission | 36.3 | 35.8 | 37.4 | 34.9 | 38.4 | 34.4 |
| other | 178.4 | 194.5 | 176.2 | 181.5 | 222.1 | 173.5 |
| fsync_count | 103.2 | 73.8 | 103.2 | 73.8 | 103.2 | 73.8 |
| written_bytes | 153,225.2 | 152,195.5 | 152,967.5 | 153,024.8 | 151,857.0 | 153,466.8 |

## Primary SDK samples

| Task | Calls | Runtime before, ms | Runtime after, ms | Gap before, ms | Gap after, ms |
|---|---:|---:|---:|---:|---:|
| 03-window-padding | 16 | 2737.7 | 1204.9 | 140.9 | 63.2 |
| 07-source-manifest | 14 | 1181.9 | 954.3 | 61.4 | 59.9 |
| 09-separator-payload | 14 | 1815.7 | 1629.2 | 104.1 | 102.7 |
| 12-partition-map | 19 | 3072.9 | 2492.5 | 143.8 | 121.7 |

## Tool invocation spans

Inclusive milliseconds per task. Real commands still run; their timing variation is excluded from the primary runtime metric.

| Tool | SDK before | SDK after | Cold before | Cold after | CLI warm before | CLI warm after |
|---|---:|---:|---:|---:|---:|---:|
| FileRead | 29.2 | 26.2 | 33.0 | 29.4 | 90.0 | 27.5 |
| MultiEdit | 18.0 | 15.9 | 16.2 | 19.5 | 104.9 | 14.9 |
| TodoWrite | 7.8 | 8.1 | 8.1 | 11.4 | 7.8 | 7.8 |
| Write | 61.2 | 59.8 | 58.4 | 57.9 | 103.2 | 58.6 |
| exec_command | 3,119.4 | 2,929.7 | 2,805.0 | 2,880.3 | 3,072.7 | 2,803.1 |
| write_stdin | 2,084.3 | 2,182.1 | 2,157.1 | 2,236.2 | 1,973.7 | 2,150.8 |

## Remaining cost

Warm bootstrap metadata now costs 3.2 ms/task. Warm bootstrap services cost 11.9 ms, session work 38.7 ms (including mount 30.0 ms), shell preparation 9.9 ms; other stages are small. Config, authority, registry and permissions together are under 4 ms. The full RPC create mean is 97.3 ms; an average does not guarantee every session is below 100 ms.

The remaining primary runtime is 570 ms/task over target; mean boundary overhead is 49 ms over target. The post-tool partition still contains 143 ms of explicit fsync and 200 ms of SQLite immediate/regular transactions per task, plus 124 ms prompt assembly and 195 ms unclassified work. A separate CPU/native-I/O diagnostic identifies additional SQLite autocommits in the in-flight tool recovery observer. Those rows participate in crash recovery and unknown-outcome gating; moving them off-path requires an explicit canonical replay/catch-up design.

Grouping is deliberately limited to the admission boundary. Separate dispatch checks, effect intent/result commits and model checkpoints still flush independently. Combining those needs a transaction protocol across owners, with recovery tests for every acknowledged boundary, rather than a timer or a weaker SQLite sync mode. No concurrency, prompt-layout or tool-presentation experiment was added in this round.

## Tests and limitations

- Core source and test-support typecheck pass on the final production source.
- Official Linux focus on `07e5d8240` (before the no-op namespace fix): 43 files, 691 tests pass, one existing skip. Covers budget, durability, admission persistence/recovery, session/event storage, bootstrap services and model metadata.
- Full Linux suite on measured source: 2,691 files pass, 30 fail, one skips; 32,648 tests pass, 86 fail, 11 skip. Pinned main baseline: 2,683 files pass, 35 fail, one skips; 32,638 tests pass, 83 fail, 11 skip. Both runs report the same three blocked/unconsumed public-network attempts.
- Every file containing a case absent from the main failure list was rerun alone with the official runner. All seven pass: workflow permissions 8, SIGKILL matrix 15, benchmark faults 47, grep isolation 4, memory index 45, plugin settings 61, compaction 3. No reproducible new failure remains. The broad suite itself is not green.
- Final local admission/event/crash focus: 112 tests pass, including all 15 crash cases. No-op state/consent: 26 pass. Model-manager: 41 pass. New group/cache tests: 9 pass. Replay/summary Python tests: 7 pass, including warm-window exclusion of priming.
- `round2-test-evidence.json` preserves the full failure comparison and isolated-rerun summaries, including actual test exits. Official PC runner labels: `light-runtime-r2-focus`, `light-runtime-r2-full`, and `light-runtime-r2-alone-01` through `07`.
- Authored-file credential-pattern scans on both machines found no suspicious literals; matching values were never printed. No real provider key was loaded for Round 2.

Round 2 remains a partial performance improvement. No paid repeat was warranted: zero-cost replay isolates the remaining runtime gap, while another nondeterministic model sequence would not resolve it. The prior $0.048834084 four-task Flash check and its task12 evidence limitation remain documented in ROUND1.md. This round does not claim a Pi/Grok live parity result.
