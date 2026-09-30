# Light integration and evaluation status — 2026-09-30

Light has reviewed runtime fixes, narrower startup dependencies and stronger
offline evaluation evidence. **There is no current, prospectively matched
Light-versus-Pi benchmark establishing superiority.** The ordinary CLI-to-observer
composition and current Linux validation remain incomplete.

This is a dated engineering checkpoint, not a release announcement. It separates
code committed on `light/final-integration`, historical paid development panels,
and external prospective fixtures. Nothing under the private `/tmp` harness
directories described below is thereby shipped with AgenC or approved for paid
execution. Existing [evaluation contracts](../evaluation-contract-v1.md) and
[required gates](../ci-required-gates.md) remain in force.

## Branch and artifact identity

Preservation update: operator-side source/configuration files now also live in
[`experiments/light/2026-09-30`](../../experiments/light/2026-09-30/README.md),
with original-byte hashes. Evaluation evidence is being preserved separately in
the private Desktop archive branch under `light-evaluation-2026-09-30/takeover`.
These copies are historical/experimental material, not installed runtime modules
or a claim that disabled CLI fixtures have executed.

| Identity | Verified scope |
| --- | --- |
| Current documented HEAD `bf23c4d36b68a6b57880cad76817c6e62b40124a` | Local `light/final-integration`; adds the reviewed jobs test diagnostic, narrow strict type gate and its package/ignore wiring. No production-source change from `403da`. No new full build was run on this head. |
| Last clean install/type/build checkpoint `403da04398b55e51d1f4e8814f9a70957b0db5ef` | Fresh Git archive, Darwin arm64, Node 26.8.1 / npm 11.17.0; install, all then-current normal type projects, build, **63 files / 1,056 tests, zero skips**. Built runtime 0.18.0 VERSION matches this exact commit. |
| Archive SHA256 | `b684a0b8857ade377f06c5ca9e528ff4126ee26f8ee43bb036c430b3a398a4e0` |
| Selected external CLI artifact | Still immutable `403da`; later test-support changes were not silently substituted into an already selected artifact. |

The local commits are not evidence of push, merge, release or deployment. The
1,056-test selection is not the entire repository suite and is not a Linux run.

## What the branch implements

`agenc --light` remains an experimental startup option: begin with core tools
and discover more as needed. It is not `--bare`, an approval bypass or a new
sandbox mode. The public configuration switch `light_reasoning_policy` defaults
to `fixed`; opt-in `adaptive` is a different treatment and must be identified in
any comparison.

Commit abbreviations below resolve in this branch's Git history. Source links
describe the current implementation; they are not claims about historical cells.

| Change / commit | Current code and preserved boundary |
| --- | --- |
| Fixed reasoning by default — `3a4215afb` | [`light-reasoning.ts`](../../runtime/src/session/light-reasoning.ts) only changes low→medium for explicit `adaptive`, supported medium effort and a completed failing validation in the latest tool batch. Fixed/absent policy preserves configured effort. See [`light_reasoning_policy`](../reference/config.md), including restart configuration semantics. |
| Smaller eager startup graph — `09506769e`, `160085e4c` / `aaf332b45`, `ec45a1e49` | Canonical daemon control is separate from foreground services; local-turn runtime and command executors load lazily. Parser/help/type leaves preserve public bindings and command behavior. This does not remove admission, sandbox startup, durability or normal daemon ownership. |
| Creation-interface experiment — `814d0d791`, `b82ae4dec` | [`light-profile.ts`](../../runtime/src/tools/light-profile.ts) initially exposes `FileRead`, `MultiEdit`, `Write`, `exec_command`, `system.searchTools`; the full canonical catalog remains selectable. Compact schemas/presentation reuse canonical `Write`, not a new mutation executor. Cost/quality benefit is **unproven**. The isolated experiment did not rewrite the workflow prompt to establish causality. |
| Admitted Write coverage — `742811377` | [`run-turn.light-write-admission.test.ts`](../../runtime/tests/session/run-turn.light-write-admission.test.ts) uses real canonical admission: create, read-before-overwrite, missing/stale read and permission/admission refusals, tool-stage denial and retained receipts. Store reopen is not a process-crash/exactly-once proof. |
| Successful terminal before executable calls — `28e21d055` | OpenAI Responses incomplete/error/failed responses cannot dispatch a tool merely because an item-done event occurred. Tests use actual provider→runTurn with synthetic transport and a counting tool. |
| Bounded truncated-call recovery — `79b8c112f` | [`incomplete-tool-calls.ts`](../../runtime/src/llm/wire/incomplete-tool-calls.ts), provider/stream phase and [`max-output-tokens.ts`](../../runtime/src/recovery/max-output-tokens.ts) retain only bounded, unambiguous IDs/names, never incomplete arguments. Length recovery requests fresh complete JSON under existing retry/cap/effort/admission rules; contradictory metadata omits the diagnostic batch. Orderly reconstruction preserves the correction and spent recovery count, not a newly recharged retry. This is not crash-durability evidence. |
| Same-invocation attachment evidence — `45132f5aa` | [`orchestrator.ts`](../../runtime/src/prompts/attachments/orchestrator.ts) optionally collects detached, frozen, bounded outcomes from the same producer invocation. Fulfilled means the invocation fulfilled, **not** that every internally caught operation succeeded. Overflow becomes unknown. Default no-sink behavior and cancellation identity remain. |
| Admission correlation — `580734037` | [`admitted-model-call.ts`](../../runtime/src/budget/admitted-model-call.ts) records the existing validated managed request UUID in durable dispatched details and passes the same scalar onward. A journal correlation is not semantic approval, wire provenance or a new request ID. |
| Selected semantic validation — `bd88a2518` | [`prepared-sampling-evidence.ts`](../../runtime/src/session/prepared-sampling-evidence.ts), Session and runTurn validate only the selected main preparation after context fit/reprepare and before its admission/retry loop. Strict bounded digests distinguish absent/null/undefined, reject unsupported values and expose no raw prompts/tool schemas. Earlier auxiliary calls are not retroactively approved or free. An absent hook avoids report serialization. |
| Physical EOF ownership — `44aed233a` | Responses consumes through actual EOF; terminal/DONE markers alone do not release executable tools/final success. Later conflicting data, malformed frames/UTF-8 and read failures refuse. [`client-session.ts`](../../runtime/src/llm/client-session.ts) uses the combined caller/deadline signal, cancels unread readers best-effort on non-EOF exit, releases local resources and never retries after yielding bytes. Cancellation promises are observed, not awaited indefinitely or represented as completed external I/O. No new default idle timeout is invented. |
| Trusted CLI validator forwarding — `c27cf4e02`, test compatibility `403da0439` | Bootstrap, background-agent start/restore and `runAgenCDaemonForeground` capture/forward a trusted constructor/entry callback. Input mutation cannot swap it. Canonical startup still requires sandbox readiness; foreground rejects a validator with a custom runner. There is no function-in-config/environment/RPC interface. |
| Portability and fixture quality — `e6f2e90c9`, `790d47243`, `9de407832`, `bf23c4d36` | Real browser symlink fixture, Linux watcher initialization before fd baseline, corrected M4 fixtures/strict support gate, and jobs reporting diagnostics. These do not turn every historical timeout into a fixed runtime defect. |
| Plugin regex-worker correctness — `a793fdb85` | Startup allowance is separate from execution budget; private input snapshot and monotonic deadlines preserve existing safety. This is not a promise of a hard total wall limit. |

The selected semantic hook is intentionally not a generic all-call wire monitor.
Its constructor-held validator must return exactly `undefined`; callback failure
refuses the selected request, native rejected Promises are contained without
awaiting arbitrary thenables, and cancellation remains primary. Core permissions,
sandbox, admission and durable effect handling are not replaced by benchmark code.

## Historical Light / Pi observations, not a current matched result

Paid observations below used the original twelve development tasks and retained
original outcomes. Task 12 had unequal planning-tool requirements; neither a
silent rescore nor a passing artifact check makes it a fair planning comparison.
These tasks were repeatedly used during tuning and are not held-out confirmation.

| Observation | Light | Historical Pi repeat 1 | Interpretation |
| --- | --- | --- | --- |
| Flash C16, `0638f0267b70a241c3a34c21214ad0659d582bc5` | 12/12 original passes; 171 calls; 2,057,286 input+output tokens; 212,934 uncached+output; median 31.955 s; p90 96.423 s; cost $0.078070806 | 12/12; 214 calls; 2,379,162 raw tokens; 203,546 uncached+output; median 44.580 s; p90 91.231 s | Lower raw traffic/median, higher uncached+output/p90. Complete candidate usage, no provider errors. No strict matched pairs; mixed evidence, not superiority. |
| Luna fixed-only control, `3a4215afb0a6b9b5de54714a6c576397b82e4da3` | 12/12; 120 calls; 699,130 raw tokens; 141,687 uncached+output; median 25.621 s; p90 42.167 s; total cell wall 357.312 s; $0.02890313 | 12/12; 120 calls; 851,968 raw tokens; 130,001 uncached+output; median 24.410 s; p90 37.035 s; total wall 313.772 s; $0.02769137 | Raw tokens −17.94%, but uncached+output +8.99%, cost +4.38%, wall sum +13.88%. No strict matched pairs; no Write treatment in this control. |
| Current `bf23` / built `403da` | Focused correctness/build gates; external synthetic component/client diagnostics | No matched current paid baseline | **No current completion, cost or latency comparison exists.** SDK/source diagnostics do not substitute for the intended ordinary CLI/app treatment. |

Costs are recorded historical API list-rate accounting, not current prices or
account balances. Raw, cached, uncached, output and reasoning tokens are not
interchangeable metrics. Task-cluster intervals excluding task 12 crossed zero
for relevant token/wall comparisons: inconclusive is not equivalence.

The corrected Luna panel's 120 wires used low/auto/8192 and requested encrypted
reasoning replay. Its audit matched 184 later input reasoning items to 42 earlier
completed outputs, without exposing opaque content. This is a historical
lineage observation, not a claim that an `include` declaration proves replay on
every future call. Sources: evidence E2 below.

Output attribution also rejected an assumed optimization: in task 07, 82.8% of
Light's excess output was provider-reported reasoning, not duplicated search
strings. This motivated a small canonical Write exposure experiment, not a new
edit executor or a claim that changing the interface already saved money.

### Startup measurements have a different denominator

The cold-CLI parser/executor split compared Light to its own previous build:
control `aaf332b45d0ec7b2f6f7b6e223b5648c8bab2d6d`, treatment
`ec45a1e49a6e563391830b07ff54ac483bed5180`. Five alternating pairs/ten valid
network-none synthetic observations gave mean **1.4839779646 → 1.3025589514 s**,
181.419 ms / 12.225% lower; all five differences favored treatment. Fresh
process/private-home startup is not cold disk, isolated-host latency, model
quality or Pi superiority. Earlier local-turn laziness showed no demonstrated
gain (1.487683 → 1.491264 s); do not add gains from separate experiments. E3
retains exact artifacts, resource limits, pairs and mistaken smoke expectations.

## Current offline validation and remaining scope

| Evidence | Result | What it does not establish |
| --- | --- | --- |
| Clean `403da` gate, E1 | Install, standard types, build; 63 files / 1,056 tests, zero skips | Full suite, Linux or `bf23` full-build validation |
| Jobs diagnostic on copied `403da` plus exact adopted patch, E4 | Strict types `18050/52cd5f`; entire file `4984/9b79e3`, 21/21, zero skips, including unchanged 4,097-row case and injected refused/thrown result reporting | Cause/resolution of the original loaded Linux timeout; production scheduler change |
| Isolated unchanged `403da` compaction, E5 | `86798/a409bf`, 3/3, zero skips; includes 1,657 complete tool pairs and cold reopen | Loaded Linux behavior or performance gain |
| Native Light and Pi continuation diagnostics, E6 | Each uses the actual selected source/SDK, native read, second provider request, two financial admissions/known settlements and two ordered publications with fake network; first output checklist score accepted | Current canonical CLI bootstrap, paid quality, planning semantics or final production parent authority |
| Shared finalizer→scorer, E7 | `53f500`, 4/4; actual returned Node token passed to Python, both-arm controls and missing-ACK/tamper refusals | Actual client lifecycle: inputs in this component test were synthetic |
| New parent lifecycle, E8 | `7b772b`, 59/59, zero skips on lifecycle `e7d5b4bc…`; tracks true pending work and live sticky invalidity | Real daemon authentication, journal quiescence or publication authenticity |
| Actual local IPC glue, E8 | `02c90e`, 1/1, zero skips; four owned real Node children all exited/closed/disconnected | ACKs and Light identity were synthetic; no Core/Pi/observer/provider/journal imported |
| Companion strict types, E9 | Corrected companion-only `74501/1b3fa6`: zero diagnostics; expanded companion+preflight `53832/27d227`: zero diagnostics on its first run | **No bootstrap, source-loader or CLI preflight execution.** Inert resource guards passed separately, 7/7. |

The native Light diagnostic is pinned to `44aed`; Pi uses installed 0.73.1.
Source inspection found the 60 base-binding files unchanged between `44aed` and
`403da`, and five canonical identity/control files unchanged from `ec45` to
`403da`. This supports an explicit compatibility selection, not whole-build or
full dependency-closure attestation. The current companion still has disabled
execution and unset deployment approvals.

### Failures retained, not replaced by later green results

- The original Luna C16 phase stopped on unexpected model settings after two
  attempted tasks/17 admitted calls. One task remained a failure despite passing
  its code check. A later source-controlled fixed-policy correction and new phase
  do not rewrite that attempt, its stop or historical reservations.
- A separate twelve-cell Luna startup phase failed before any model call because
  the harness omitted `config_version = 2`. The corrected new phase is separate.
- Historical runtime round 3 recorded **32,650 passes / 87 failures / 11 skips**.
  Later isolated triage and focused passes do not make that run green or prove
  that 87 current bugs remain. M4 readiness stages, 256/257 workflow handoff
  cleanup and loaded Linux behavior still require exact-source reconciliation.
- Source-to-observer v2 remains 7/8; the cancellation diagnostic remains 2/3.
  Public whole-turn cancellation completed with unknown full reservation hold
  and stop. Provider-only signal override rejected at the provider but the turn
  did not return; cleanup was not entered. The exact pending await was not
  established, so this is not proof of a hanging Session shutdown or license for
  an unmotivated product change.
- Original EOF parser CR/comment failures, incomplete-identity contradictions,
  capture publication/cancellation defects and rejected accounting prototypes
  remain in separately pinned reviewer records. New versions did not overwrite
  their evidence.
- The first `c27` clean gate failed on test-only `Promise.withResolvers` ES-library
  compatibility; build/tests did not run. `403da` corrected the fixture without
  changing compiler flags. Earlier shared-checkout TS2883 dependency-symlink
  errors were retained; clean archive gates used independent normal dependencies.
- Jobs' first targeted strict gate found three previously unselected test type
  errors; explicit return/`this` annotations fixed them without policy weakening.
  The first companion gate retained TS1470; correction moved sibling path
  resolution into its ESM helper. The later file named
  `preflight-types-first-red.log` is empty from a **passing** first expanded gate;
  its filename does not indicate failure.

## Concrete completion obligations

1. **Run independent canonical CLI preparation under supported containment.**
   Produce expectations before observing live requests, with ordinary bootstrap,
   sandbox readiness, permissions, settings/workspace and empty-resource
   equivalence. Do not disable normal producers or learn hashes from their live
   report to fit a fixture. Typechecking the draft is not this test.
2. **Finish the one-call real CLI composition.** Select a complete companion/CLI
   build using one scoped-Session graph; synchronously publish the independent
   initial binding with only declared generated identity slots; join selected
   UUID→SQLite allowed/dispatched→actual provider→observer financial admission.
   Use normal CLI task client and canonical owned daemon identity/shutdown.
   Connect strict ACK dispatch to actual live lifecycle/pending-writer facts and
   the shared finalizer. Never infer expected root/contract from a received ACK.
3. **Clear platform-specific gates honestly.** The attempted Darwin outer sandbox
   denied external TCP but also blocked canonical process inspection and nested
   sandbox startup; it cannot contain the unchanged CLI as configured. Last
   read-only Linux connection check `10060/abda91` exited 255 on connection
   timeout before authentication; no remote command ran or password was used.
   Remote process state is unknown. Restore approved reachability before inspection or
   launch, rather than bypassing identity/sandbox or retrying unknown jobs.
4. **Resolve relevant Linux/full-suite proof gaps.** Run only justified current
   affected gates after source/artifact selection, including M4 readiness/crash
   wiring and descriptor-dependent workflow tests. The jobs change improves
   failure diagnosis; isolated Mac compaction does not clear loaded Linux.
5. **Freeze a genuinely fair prospective panel.** Same visible task 12 behavior,
   explicit client/provider/model settings on every call, retries/replay/floors/
   budgets and resource/time boundaries; separate original code outcome, visible
   protocol format, unknowns and transport/normal-exit failures. Capture output
   SSE only as planning evidence, never inputs or rendered logs. Inventory every
   attempt and retain stops/holds; no best-of replacement. Flash needs its own
   current Chat/proxy integration, not assumed coverage from Luna.
6. **Obtain independent confirmation.** Run serially under separately approved
   provider-spend authority with no overlapping builds/suites/timings; use fresh
   prospective repeats/held-out evidence after freezing the candidate. Historical
   list-rate fixtures, subscription quota and API balances are different things.

No item authorizes clearing a stop, deleting evidence, changing financial policy,
spending credits, weakening protection, or merging/releasing the branch.

## Reproduction and evidence locations

Repository checks below are reproducible commands, **not commands executed while
writing this document**. Use a fresh exact-commit checkout/dependency tree and
the repository's supported toolchain. A later rerun is new evidence, not a reset
of a completed historical gate. Review platform requirements before execution.

```sh
# Repository root; clean exact selected commit, Node 26.8.1 / npm 11.17.0
npm ci --prefer-offline --no-audit --no-fund
npm run typecheck --workspace=@tetsuo-ai/runtime
npm run build

# Focused examples from runtime/; normal hermetic runner, no filtered skips
node scripts/run-hermetic-vitest.mjs --require-zero-skips run \
  tests/bin/bootstrap.prepared-sampling.test.ts \
  tests/app-server/background-agent-runner.prepared-sampling.test.ts \
  tests/session/run-turn.light-write-admission.test.ts \
  tests/session/run-turn.truncated-tool-recovery.test.ts \
  tests/session/run-turn.responses-terminal-safety.test.ts \
  tests/llm/client-session-stream-close.test.ts \
  tests/llm/providers/openai/adapter.responses-eof.test.ts \
  --maxWorkers=1 --no-file-parallelism

npm run typecheck:jobs-test-support
node scripts/run-hermetic-vitest.mjs --require-zero-skips run \
  tests/agents/jobs/job-orchestrator.test.ts --maxWorkers=1 --no-file-parallelism
```

The exact 63-file selection, clean environment/build-identity controls and logs
are retained in E1's `run.mjs` and `result.json`; the examples above are not a
claim to reproduce its test count. Do not rerun its single-use driver/reset its
started marker. Current normal typecheck also selects the newly added jobs gate.

Evidence below uses the **original retained operator locations**. Selected files
are additionally preserved in the private Desktop Git archive with the same
relative paths and byte hashes; they are not public Core evidence data. Paths
are locators for review, not portable clone links or commands
to launch a provider. `E` denotes `/private/tmp/light-takeover/`.

| ID | Authoritative retained paths |
| --- | --- |
| E1 | `E/local-validation-cli-validator-v2/{result.json,run.mjs,typecheck.log,focused-tests.log}`; immutable source `/private/tmp/light-clean-cli-validator-v2-GANyA9/source`; preceding failure `E/local-validation-cli-validator/result.json` |
| E2 | `E/evaluation-audit/README.md`, `report-20260930-v2.json`, `FIXEDCONFIG-RESULT.md`, `report-20260930-fixedconfig.json`, `transport-20260930-fixedconfig.json`; `E/FIXEDPOLICY-VALIDATION-RESULTS.md`; `E/edit-efficiency/REPORT.md` |
| E3 | `E/startup-cpu/COLD-CLI-RESULT.md`, `cold-cli-ab-summary.json`, `cold-cli-ab-provenance.json`, `LOCAL-TURN-RESULT.md`; summary SHA256 `f742b0c6ef61d34a5b4069a54b05a2413345b8678dd983c99f053decc1e9c557` |
| E4 | `E/full-suite-triage/jobs-diagnostic-v1/ROOT-VALIDATION.md`, `root-first-test-result.json`; original inventory `E/r3-test-evidence.json`; current reconciliation `E/full-suite-triage/current-403da-storage-review.md` |
| E5 | `E/local-compaction-403da/result.json` |
| E6 | `E/fair-confirmation/{light-tool-continuation-v1,pi-tool-continuation-v1}/RESULT.json`; independent reviews `E/evaluation-audit/{LIGHT,PI}-TOOL-CONTINUATION-V1-REVIEW.md`; cancellation `E/evaluation-audit/CANCELLATION-DIAGNOSTIC-V1-REVIEW.md` |
| E7 | `E/fair-confirmation/shared-parent-finalizer-v1/CROSS-LANGUAGE-RESULT.md`; `E/evaluation-audit/SHARED-PARENT-FINALIZER-NODE-REVIEW.md` |
| E8 | `E/fair-confirmation/current-cli-observer-v1/ROOT-IPC-RESULT.md`, `PARENT-LIFECYCLE.md`, `parent-lifecycle.test.mjs`, `parent-dispatch.test.mjs`; lifecycle SHA256 `e7d5b4bcaf5151cc5fec7c0128358891046af61fde863f3bc6cc3ec7e94793ad` |
| E9 | `E/fair-confirmation/current-cli-observer-v1/{companion-types-first-red.log,companion-types-corrected.log,preflight-types-first-red.log,tsconfig.companion.json}`; expanded strict config SHA256 `771aaec63e0a6ec9bde0a14c207c58c295e642929ec3218a6a66efcc70463470`; original companion-only config retained as `tsconfig.companion-only.accepted.json`; `E/evaluation-audit/CURRENT-CLI-READINESS.md`; latest scope updates in `E/HANDOFF.md` top |
| E10 | `E/fair-confirmation/current-cli-observer-v1/CLI-BINDING-REUSE.md`; `E/fair-confirmation/darwin-containment-v1/RESULT.md`; `E/COMPLETION-AUDIT.md` (read newest assessment before retained historical sections) |

External scripts are versioned prototypes with their own pins and approval
boundaries. The repository documentation intentionally contains no credentials,
raw captured prompts, opaque reasoning payloads or private transcripts.

## Git preservation checkpoint

The owner selected public Core for code/technical docs and private Desktop for
evidence. [The source inventory](../../experiments/light/2026-09-30/README.md)
preserves 848 original source/configuration files across takeover and predecessor
experiments, including a four-file uncommitted historical runtime overlay. The
private `archive/claude-session-4e2cff2c` branch in `tetsuo-ai/agenc-desktop`
preserves 2,085 original files with per-file hashes under
`light-evaluation-2026-09-30/`, plus the unchanged original Claude archive.
Reviewed accounting ledgers remain private and byte-identical. Separate original
experimental branches were verified remotely; they were not merged here.

At the preservation checkpoint the callback publisher and synthetic tests were
frozen but unexecuted. The subsequent
[callback validation checkpoint](../../experiments/light/2026-09-30/callback-validation-v1/CALLBACK-VALIDATION.md)
now passes **25/25 offline tests, zero skips, and strict no-emit TypeScript**.
The first typecheck failure is retained; the only correction supplies the test's
actual filesystem explicitly to the financial owner. Callback production logic
remains unchanged. This is not actual observer/client execution or a new model
benchmark result. All deployment/containment gates remain false; the Linux PC
still timed out before authentication and its saved control connection was absent.
