# Resumed Linux correctness gate — 2026-09-30

**PASS: 64 files, 1,077 tests, zero skips.** Fresh dependency installation, all
normal runtime type projects and canonical build also passed on Linux. All four
owned containers exited0 with OOMKilled=false. The test report's 57.94-second
duration is not a Light latency benchmark. Execution87963/bf6728 closed exit0.
This result is not authorization to rerun the single-use driver.

The separate six-file supplement completed **164 passed, zero failed, one
skipped** (131.06 seconds). Its strict zero-skip wrapper exited1 because
`workflow-handoff-store.test.ts:168` declares a Darwin-only refusal test.
No assertion was weakened or test rerun. Combined disjoint coverage is 70 files,
1,241 passing tests and one explicit platform skip, not a full-suite green result.
M4 durability, plugin settings, browser profiles, descriptor cleanup, workflow
storage and long compaction all completed their Linux-applicable assertions.
Both original outcomes remain separate in the private evidence archive.

## Selected inputs

| Input | Exact selection |
| --- | --- |
| Tested source snapshot | `38d63e586a92c4da8b1e51b31d46f74ee359a55a` |
| Selected product baseline | `403da04398b55e51d1f4e8814f9a70957b0db5ef`; root verified no `runtime/src` diff to the tested snapshot |
| Source archive SHA256 | `967d3ce27c6d56ba1fcc8e44445dd2e1152fcfea0e5f7bc57f3c8bc35d1b65b5` |
| Container image | `sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271` (`node:26.5.0-bookworm`) |
| Toolchain | Linux Node 26.5.0, npm 11.17.0; explicitly different from the earlier Darwin Node 26.8.1 gate |
| Dependency identity | Selected package-lock SHA256 `a6d4ca9885fc8fea507135919a7677b682b629b5a3887b4dcb665a058e8ddd94`; fresh Linux installation, not copied Darwin native addons |

Later test-support and experiment-preservation commits do not silently replace
the product selected by the CLI companion. A successful gate on this snapshot
would establish its own Linux correctness result, not retrospectively turn old
builds or historical failed runs green.

## Bounded execution

The reviewed driver runs serial install, normal runtime typechecking, repository
build, then the existing 63-file focused selection plus the full jobs diagnostic
file. The runner uses `--require-zero-skips --maxWorkers=1
--no-file-parallelism`; there is no name-filtered skip waiver or reduced jobs
fixture/deadline. The exact path list is in the preserved `run.sh`.

Each phase uses one explicitly named owned container, nonroot UID/GID 1000,
8 GiB memory, equal memory-swap limit (no extra swap allowance), two CPUs and
512 PIDs. Only the newly owned gate root is bind-mounted. Private HOME, npm cache
and TMPDIR live there on disk-backed storage, not the pressured host `/tmp`
tmpfs. A serial lock, initial 20 GiB free-space floor, 1,200-second phase timeout
and owned-container stop on failed/overdue execution bound the attempt. Logs,
exit codes and container state are retained; existing jobs/data are untouched.

Dependency installation is network-enabled with the npm registry explicitly
selected. This is **not registry-only firewall enforcement**. Type, build and
test phases use `--network none`; no provider request is authorized. Historical
host OOM/resource-pressure and disk-full incidents motivate serial resource
limits. They do not establish that a new failure is caused by OOM; per-phase
exit/container evidence must decide that. No host identifiers or environments
are published here.

## Retained evidence and limits

Original operator inputs are retained under
`/private/tmp/light-takeover/linux-resume-20260930/`; root preserves results in
the private evaluation archive. Historical round-3 JSON was rechecked as
byte-identical (SHA256
`1d3f8c36aac021ae788ff7b77058b89ac2923b445b8ff9151aeb2b7b1c53f5de`).
It still records 87 failures, 32,650 passes and 11 skips. Eight subsequent
isolated passes are separate evidence, not a full-suite pass. Collect completed
logs rather than rerunning that historical source to reconstruct evidence.

This gate does not run the real daemon/ordinary-CLI companion composition,
publish a matched Light/Pi benchmark, measure performance, spend API credits,
or prove the complete Linux deployment closure of the external observer.
Native sandbox/identity/assets, accepted independent preflight material and
the owned parent/CLI handoff remain separate obligations.
