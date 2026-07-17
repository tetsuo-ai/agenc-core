# Eval pilot executor

Status: design accepted; phase 1 (model-free preflight executor) implemented,
phase 2 (real-agent run) designed but not yet implemented.

Roadmap anchor: `todo.txt` M1 — "Build a 30-task pilot, then a powered
superiority set" and "Run the actual AgenC agent, not a mock executor".
Wave B of the execution order is gated on the first M1 seed baseline, and the
verified gap (2026-07-16 audit) is that the merged evaluation stack —
`eval-contract`, `eval-suites`, `eval-pilot`, `eval-power` — is schemas,
validators, and frozen candidate data with **no execution layer**: nothing can
take a pinned pilot task and actually run it.

## Goals

1. Execute the qualification preflights the pilot protocol requires
   (`docs/evaluation-pilot-v1.md`, "Qualification boundary"): three cold
   preflights per task proving the base fails target checks, existing
   regression checks pass, and the reference solution passes everything.
2. Provide the container/verifier machinery that the later real-agent run and
   negative-patch review reuse unchanged.
3. Emit evidence in the shapes the merged stack already validates
   (`EvaluationPilotUpstreamPreflightEvidence`, and in phase 2
   `RunRecordDocument` + evidence-ledger events). No parallel record
   vocabulary.

## Non-goals

- No model calls in phase 1. Preflights are deliberately model-free.
- No comparator adapters (separate M1 checkbox).
- No aggregate metric derivation (separate M1 checkbox; lives in
  `experiment-bundle.ts`).
- No second task engine: this executes *evaluation* tasks in containers; it
  does not touch the product workflow runner or job orchestrator.

## Inputs and trust boundaries

The unit of work is one task from the frozen source lock
`runtime/eval/suites/competitive-coding/1.0.0/task-sets/pilot/1.0.0/source-lock.json`
(kind `agenc.eval.pilot-source-lock`, 30 tasks, document digest pinned in
`docs/evaluation-pilot-v1.md`). Each task pins:

- `image` — OCI reference with immutable `@sha256:` manifest digest. Execution
  MUST use the digest, never the tag.
- `baseCommit` — the repository state inside the image.
- `artifacts` — CAS references (`cas/sha256/<hex>` beside the lock) for
  `setupPatch`, `referencePatch`, `verifierBundle` (gzip JSON, kind
  `agenc.eval.swe-bench-live-verifier-bundle`: `testPatch`,
  `rebuildCommands[]`, `testCommands[]`, `printCommands[]`, `logParser`
  (Python), `failToPass[]`, `passToPass[]`), and `sourceEvidence`.

Boundaries the executor enforces:

- **Oracle isolation.** `referencePatch`, the verifier bundle, and
  `sourceEvidence` are operator-only material. They are staged into verifier
  containers only. In phase 2 the agent workspace receives exactly the
  `projectTaskForAgent` projection (`AgentTaskDocument`) and nothing else; the
  verifier runs in a separate container after the agent's patch is collected.
- **CAS integrity.** Every artifact byte is re-hashed against its pinned
  digest and size before use; path traversal and symlinks are rejected; reads
  are bounded (16 MiB per artifact, matching the pilot CAS limits).
- **No network during verification.** All preflight/verifier containers run
  with `--network none`. Rebuild/test commands in the pinned images are
  expected to work offline; a command that needs the network fails the run
  with an explicit `network_required` diagnostic rather than being retried
  with network. (`git submodule update`-style rebuild steps that require
  egress are surfaced as candidate-QA failures for that task, which is signal
  the pilot protocol wants, not noise to suppress.)
- **Parser containment.** The bundle's Python `logParser` is frozen CAS
  content but still code; it executes inside the task container
  (`--network none`), never on the host.

## Phase 1 — preflight executor (implemented)

New module `runtime/src/eval-executor/`:

- `source-lock.ts` — first-class loader/validator for the source lock (the
  stack previously had none outside a test-local interface): bounded JSON
  read, `documentDigest` recomputation via `computeDocumentDigest`, task shape
  validation, CAS resolution with digest/size/traversal checks. Exports
  `loadPilotSourceLock`, `resolveCasArtifact`, and the
  `PilotSourceLock`/`PilotSourceLockTask` types.
- `verifier-bundle.ts` — bounded gunzip + validation of the verifier bundle;
  exports `decodeVerifierBundle`.
- `container-runner.ts` — the `ContainerRunner` interface: create a container
  from an image digest, exec bounded commands (timeout, 1 MiB output cap,
  SIGKILL on deadline), write files in, remove. `DockerContainerRunner`
  shells out to the docker CLI (repo convention — no dockerode), always
  `--network none`, workdir from image config with `/testbed` fallback.
  The interface exists so orchestration logic is testable hermetically with a
  scripted fake.
- `log-parser.ts` — wraps the bundle's `parser(log)` in a fixed Python
  harness that reads the log from stdin and prints one JSON object; runs via
  `python3` inside the task container.
- `preflight.ts` — one cold preflight run =
  1. fresh container, apply `testPatch` (+ `setupPatch` when non-empty),
     rebuild, test, parse → assert every `failToPass` entry is failing or
     absent and every `passToPass` entry passes (**base fails target checks,
     regression checks pass**);
  2. second fresh container, additionally apply `referencePatch` before
     rebuild → assert every `failToPass` and `passToPass` entry passes
     (**reference passes all checks**).
  Both phases record full command transcripts. `runTriplePreflight` executes
  three independent runs; only when all nine verdict booleans hold does it
  mint `EvaluationPilotUpstreamPreflightEvidence` (typed import from
  `eval-pilot`), with `environmentDigest` bound to the image digest, docker
  server version, and platform, and `evidenceDigest` bound to the canonical
  transcript document. Failures produce a `PreflightFailureReport` naming the
  first violated check — that task is a QA-failed candidate to replace, per
  the pilot protocol.
- `cli.ts` — `npm run eval:executor --workspace=@tetsuo-ai/runtime --` with
  `verify-lock` (load + verify the committed lock and CAS) and
  `preflight --task <instanceId> [--runs N] [--output <dir>]` (requires
  docker; refuses to run without it rather than degrading).

Evidence output layout (per task, under `--output`):
`<instanceId>/preflight-run-<n>.json` (the full run report with both phase
transcripts), `<instanceId>/preflight-summary.json`, and
`<instanceId>/upstream-preflight-evidence.json` when qualified and an
operator-task digest was supplied. Reports are canonically digestible JSON
(the run's `evidenceDigest` is bound over them) so the evidence chain in the
curation catalog can bind to them byte-for-byte. Files are written with
`wx` — an existing report is never silently overwritten.

### Failure taxonomy

Every run terminates in exactly one of: `qualified`,
`base_unexpectedly_passes` (a `failToPass` test passed on base — broken or
contaminated task), `regression_check_failed` (a `passToPass` test failed on
base — flaky or environment-sensitive), `reference_solution_failed` (gold
patch does not pass — broken verifier or patch), `patch_apply_failed`,
`rebuild_failed`, `test_command_failed` (nonzero without parseable results),
`parser_failed`, `network_required`, `timeout`, `infrastructure_error`
(docker daemon/image problems). The distinction matters: only the first four
say something about the *task*; the rest say something about the
*environment* and are retryable.

## Phase 2a — offline agent run (implemented)

Module `runtime/src/eval-executor/agent-run.ts`, CLI
`eval:executor run-agent --task <id> --overlay <dir>`. Runs the real AgenC
runtime inside a pinned task container, collects its patch, and verifies it
with the hidden verifier — all offline.

- **Overlay:** the operator stages a directory with `node/` (official Node 25
  linux-x64), `runtime/` (extracted `agenc-runtime-*-linux-x64` release
  tarball), and `mock/serve.mjs` (the bundled offline provider). It is
  bind-mounted read-only at `/agenc-overlay`. `assertOverlayLayout` checks the
  three required entrypoints; `computeOverlayDigest` records which `agenc.js`
  build was evaluated in the run report.
- **Provider:** always the in-container offline mock (`--network none`). There
  are no secrets in any container and no egress. This lane validates the
  pipeline mechanically; it does not yet measure a real model.
- **Oracle isolation (structural):** the agent container receives only the
  setup patch, issue text, and read-only overlay — never the test patch,
  reference solution, or verifier bundle. Before the agent runs, `.git`
  remotes and reflog are pruned as defence-in-depth. Verification runs
  afterwards in a fresh `--network none` container via the shared
  `verifyCandidatePatch` (reusing the preflight phase machinery, so the
  taxonomy stays unified).
- **Patch collection:** after applying the setup patch, a baseline commit is
  tagged (`agenc-eval-baseline`); the candidate is `git diff <baseline> HEAD`
  after committing any work the agent left uncommitted, transported as base64.
  This makes collection correct in three ways the first draft was not: the
  setup patch is excluded from the candidate, an agent that commits its work
  is still captured, and non-UTF-8 patch bytes survive intact.
- **Outcomes:** `verified_fix | verification_failure | empty_patch |
  agent_error | agent_timeout | infrastructure_error`. A truncated patch is
  never verified; a failed in-container mock is `infrastructure_error`, not
  `agent_error`.

## Phase 2b — real-model lane (deferred; requires egress control)

A lane that runs a real provider needs container egress to reach the model
API, which reintroduces an oracle-leak surface: a `--yolo` agent with open
egress could fetch the upstream fix (the tasks are cut from merged public
GitHub PRs) or exfiltrate provider keys under prompt injection from the
untrusted issue text. This lane is therefore NOT part of 2a. It requires:

- an egress-allowlist proxy sidecar that permits only the configured provider
  host, not raw bridge networking;
- full `.git` oracle hygiene (remove all non-HEAD refs/branches, not only
  remotes and reflog) so the fix commit is unrecoverable offline;
- provider secrets passed via `docker exec -e`, never inlined into an argv
  script visible in host process listings;
- a contamination marker in the run report until the above are proven.

## Phase 2 — evidence-ledger binding (designed, not yet implemented)

- **Agent placement:** the agent runs *inside* the task container so it can
  build and test with the image toolchain. There is no standalone agenc
  binary; the runtime is Node >= 25.9 ESM with glibc natives
  (`better-sqlite3`, `node-pty`, peer-credentials addon). The executor stages
  an overlay mount containing an official Node 25 linux-x64 distribution and
  the extracted `agenc-runtime-*-linux-x64.tar.gz` release artifact; pilot
  images are glibc-based (Ubuntu derivatives), which this depends on and
  verifies at start (`ldd` probe) with `infrastructure_error` on mismatch.
- **Invocation:** `agenc -p --output-format json` with `AGENC_WORKSPACE` set
  to the repo checkout, an isolated in-container `AGENC_HOME`, and the
  daemon autostarted inside the container. `tokenUsage`/`cacheStats` from the
  JSON result feed `RunRecordDocument.usage`; exit codes 0/1/2/130 map onto
  `FinalOutcome`.
- **Network:** default-deny egress; a loopback proxy inside the container
  forwards only to the pinned model provider endpoint, satisfying the task's
  `networkPolicy` pin. The verifier phase still runs `--network none` in a
  fresh container from the same image, with only the agent's collected patch
  applied.
- **Evidence:** each run opens an evidence ledger
  (`initializeEvidenceLedger`), appends `run.started` → `model.*`/`tool.*`/
  `usage.reported`/`artifact.recorded`/`verifier.completed` →
  `trust.assessed` → `run.finished` in ledger order, seals it, and assembles
  a `RunRecordDocument` validated by `validateEvalContractDocument` before it
  is reported. The adapter surface follows the suite contract operations
  (`start`, `deliver_task_and_record_receipt`, `disconnect_client_transport`,
  `reconnect_client_transport`, `kill_coordinator_process_group`,
  `collect_result`) so the same executor later serves the competitive fault
  plans from `compileCompetitiveFaultPlan`.

Out of executor scope but unblocked by it: independent-solve and
negative-patch reviews (human/agent processes whose *patches* the executor
verifies mechanically), stressor mechanism evidence, and curation-catalog
assembly for `loadAndValidateEvaluationPilotCatalog`.

## Testing

- Default (hermetic, no docker, no network): source-lock loader and CAS
  verification against the committed lock; verifier-bundle decode against
  committed CAS bytes; preflight orchestration against a scripted
  `FakeContainerRunner` covering the full failure taxonomy; evidence-shape
  assertions against `eval-pilot` validators. Revert-sensitive: the verdict
  tests fail if any of the nine preflight booleans stops being enforced.
- Live/opt-in (`tests/live/eval-executor-docker.live.test.ts`): end-to-end
  against a tiny locally built image with a synthetic repo and verifier
  bundle — proves the docker runner, patch application, `--network none`,
  and in-container parser execution without pulling multi-GB pilot images.
- Operator path: `eval:executor preflight` against real pilot images is an
  explicit networked/paid-time operation, like
  `refresh-eval-pilot-source.mjs`, and is never part of `npm test`.
