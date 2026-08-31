# The Verified-Change Workflow (M5)

The verified-change workflow is AgenC's fixed pipeline for producing a
review-ready, evidence-backed patch from an engineering goal:

```
intake + policy check
  -> isolated worktree
  -> inspect and plan
  -> implement
  -> run targeted and required verification
  -> independent fresh-context review
  -> finalize evidence and patch
```

It is deliberately one workflow, not a workflow engine. The pipeline shape,
step vocabulary, statuses, and stop reasons are frozen in
`runtime/src/contracts/run-contracts.ts` (`WORKFLOW_STEP_IDS`,
`WORKFLOW_STEP_PREREQUISITES`, `WORKFLOW_STEP_STATUSES`,
`WORKFLOW_STOP_REASONS`); a general DAG engine is out of contract.

## One run, one spine

A workflow run is an ordinary daemon agent run: `run.start` registers a root
run (durable `agent_runs` row, lifecycle epoch, canonical rollout journal),
and every surface addresses it by the same durable `RunId` through the
existing `run.*` method family — `status`, `result`, `replay`, `evidence`,
`cancel` all work unchanged.

There is no workflow database. Durable facts live where M3/M4 already put
them:

| Fact | Where it lives |
|---|---|
| The frozen `WorkflowSpec` | the `workflow.intake` effect's evidence (canonical JSON; its digest is the intake intent digest) |
| Step state, attempts, dependencies | projection of `run_effects` rows (`workflow.<stage>` step ids; retries append `#<attempt>`) |
| Worktree pointer | deterministic slug `m5-<runId[0:12]>` + the `workflow.worktree` effect evidence |
| Artifact pointers | producing step's effect evidence + the run's evidence ledger (`cas://sha256/...`) |
| Budget holds / reconciliation | the M3 admission journal and reservation tables |
| Terminal status | the immutable `run_terminal_results` record |

## Step semantics and recovery

Every step passes through the same durable driver: admission `acquire` →
`effect_intent` journaled under the rollout lease → dispatch at the correct
boundary → execute → `effect_result` → budget reconcile. Crash-injection
hooks (`M5_WORKFLOW_FAILPOINTS`) sit at every commit boundary.

Effect classification drives restart recovery:

- **Idempotent steps** (intake, worktree provisioning, verification
  commands, finalize) carry content-derived idempotency keys (spec digest,
  `slug@baseCommit`, `sha256(script+treeHash)`,
  `sha256(patchDigest+baseCommit)`). On resume they re-execute under the
  same key; the durability layer replays the intent as a no-op.
- **Side-effecting steps** (plan, implement, the adversarial verification
  agent, review — all agent spawns) are **adopted, never respawned**: resume
  looks up the recorded child run; a terminal child completes the parent
  effect from its durable result, a live child is re-awaited, an unknowable
  child marks the effect `unknown_outcome` and the run terminates
  `unknown_outcome` with review pending. No mutation is ever silently
  replayed. Adoption survives daemon restarts: when a spawned child settles,
  its terminal outcome is durably recorded through the EXISTING run
  machinery (its own `run_lifecycle_epochs` + immutable
  `run_terminal_results` rows, keyed by the deterministic child run id the
  effect intent already carries) BEFORE the parent `effect_result` can
  commit. A post-restart `inspect(childRunId)` therefore adopts the durable
  terminal — this closes exactly the
  `after_spawn_before_effect_result` crash window when the child finished
  first. The independent-review child gets the same treatment even though
  it settles inside its own effect execution: the controller records its
  durable terminal (whose payload carries the parsed ReviewOutput and the
  recorded `independent_review` artifact pointer) strictly before the
  review `effect_result` can commit, so a crash in the
  `before_review_commit` window resumes to the same committed review by
  adoption — the reviewer is never re-invoked. A child that genuinely died
  mid-flight with the daemon recorded no terminal and honestly stays
  "unknown" → `unknown_outcome`; a review terminal whose payload cannot be
  decoded is treated the same way.

Child usage is reported honestly from the durable source that already
exists: the admission kernel reconciles ACTUAL provider usage per
reservation, so a real delegate child's rollup is the sum of the reconciled
reservations under its own admission run id
(`sumReconciledUsageByRunId`). `held_unknown` reservations are surfaced as
a count in the step evidence and never summed — reserved is never reported
as spent, and a child with nothing reconciled reports `null`, not invented
zeros. The rollup rides the durable child terminal and step evidence, so
replayed and adopted steps re-accumulate it into the post-restart terminal
usage. Honest residuals that remain: a child's own sub-agents admit under
their own run ids and are not folded into the child's rollup, and the
independent reviewer's one-shot model spend is not attributed to the
review child's rollup.

Dependency unlocks stop on failed verification, cancellation, budget
exhaustion, and `unknown_outcome` — enforced first by the controller's
prerequisite gate, and structurally by the durability layer (the
unknown-outcome mutation gate and the terminal-epoch refusal in
`beginEffect`).

A failed verification earns one bounded re-implement attempt
(`workflow.implement#2`, fresh verify sub-steps) when the spec's
`maxImplementAttempts` and remaining budget allow; otherwise the run
terminates `failed/verification_failed`.

## Session policy

The frozen spec's `permissionMode`, unattended allow/deny lists, and the
model/provider the run was started with govern the run's daemon session.
`workflowSessionArgv` (`runtime/src/app-server/workflow/session-adapters.ts`)
builds that session the same way the background-agent runner does:
`--permission-mode`, `--model`, and `--provider` on structured bootstrap argv,
plus the unattended permission-policy install on the session's
permission-mode registry. Only the executable and entrypoint come from the
daemon process; daemon launch flags are never a child-session configuration
authority.

The CLI exposes `--model` only (`runtime/src/bin/run-cli.ts`). The daemon
`run.start` RPC and SDK `startRun` also accept `provider`. Without those
fields reaching bootstrap argv, `agenc run start --model` used to be
accepted, frozen into the spec, and then ignored; the run session took the
daemon default, and children inherited that **provider** while only the
model *name* could be overridden per child. A Grok or OpenRouter model name
sent to the wrong endpoint then failed at `plan` as `step_retries_exhausted`.
Resumed runs re-resolve the same policy from the durable intake spec, so a
restarted daemon never silently downgrades a run to its default policy or
model.

## Checkout protection

The user's checkout is recorded (exact base commit + a digest of the dirty
state) at intake and never touched afterward. All agent changes happen in
the workflow worktree; the reviewable patch and changed-file list are
exported and content-addressed into the evidence ledger BEFORE any cleanup —
`cleanupAfterEvidence` requires the branded proof token minted only by a
sealed ledger, so cleanup-before-evidence cannot compile.

Base movement is detected against the frozen base commit and classified by a
real `git apply --3way` in a disposable probe worktree (never the checkout):
`unmoved`, `rebase_clean`, or `conflict` with the conflicting files —
surfaced explicitly, never overwritten.

Staging and committing write the worktree's index. A linked worktree keeps
that index under the main repository's `.git/worktrees/<slug>/`, outside the
sandbox checkout. `exportPatchArtifacts` therefore uses `runGitMutation`
(`git add -A` then a snapshot commit) with the git root granted, not the
read-only git helper. A leftover `Read-only file system` on
`index.lock` after this landing is a sandbox grant bug, not expected
workflow behavior.

Cleanup pins the delivered snapshot under `refs/agenc/runs/<runId>`
(`workflowRunRef`) **before** deleting the worktree branch. The ref lives
outside `refs/heads`, so it does not clutter branch listings. If the pin
fails, the worktree stays: a leftover worktree is a nuisance and a lost
deliverable is not. Operators inspect the product with
`git rev-parse refs/agenc/runs/<runId>` after a successful finalize.

## Verification and review are completion, not metadata

`completed` is computed at one choke point and requires, mechanically:

- every required verification command exited 0 (captured with exit codes,
  durations, and output digests),
- the adversarial verification agent's terminal `VERDICT: PASS` (a missing
  or malformed verdict is a failure, never an implicit pass),
- an independent review with zero blockers, produced in a fresh context that
  saw ONLY the task, the diff, and the verification evidence — the
  implementer's conversation cannot reach the reviewer by construction, and
  the reviewer model is pinned in the spec at intake,
- a self-validated `agenc.run.verified-change-record.v1` evidence document
  (schema + digests + required artifacts) and a sealed, hash-chained
  evidence ledger.

Anything else terminates `failed`, `cancelled`, or `unknown_outcome` with a
machine-readable stop reason from `WORKFLOW_STOP_REASONS`. Non-blocking
reviewer findings are preserved as a `risk_register` artifact and in the
terminal message — surfaced honestly, never converted into success text.

The reviewer is invoked once, has no tools, and its reply is taken as final.
The prompt says so (`buildReviewerMessages` in
`runtime/src/workflow/independent-review.ts`). An unstructured reply (no
`ReviewOutput` JSON) earns **one** repair turn
(`REVIEW_REPAIR_INSTRUCTION`). A second unstructured reply fails the step
with a bounded excerpt of the invalid reply; it is never treated as approval.
`step_retries_exhausted` after `workflow.review` with
`no structured ReviewOutput (N chars): <excerpt>` means the reviewer narrated,
refused, or was truncated. The failure does not undo implement or verify.

Plan/implement/verify children that die before they speak now record the
child `outcome` and a bounded `error` in `finalMessage`
(`workflowChildFailureMessage`). An empty `final_message` is no longer the
expected signature of a model that could not answer.

Child registry names are derived by `workflowChildAgentName`: the child run
id is lowercased and every character outside `[a-z0-9_]` becomes `_`.
`assertValidAgentName` rejects dashes, colons, and `#`, which a raw
`wf-example:plan#1` id carries. The fold is required. Without it, every spawn
failed as `agent_name must use only lowercase letters, digits, and
underscores` and the run ended at `plan` with `step_retries_exhausted`.

The agents-rail `agent_runs.status` is updated in the same transaction as
`run_terminal_results` for the current epoch (cancel-locked rows keep their
cancel; child `wf-example:plan#1` ids have no rail row). Reopening a run mirrors
the rail back to `running` so startup recovery does not treat in-flight
tool calls as orphans. A finished run that still lists as `running` is a
pre-#1765 residue, not current behavior.

## Approvals (M5 semantics, frozen)

The intake step resolves approvals up front: a spec that would require
interactive approval under the declared policy is rejected before any work
or spend. If a mid-pipeline admission still returns `approval_required`, the
run terminates `failed/approval_required`. There is no approval-parking
subsystem in M5; upgrading that to a parked-and-resumable step is an
explicit future contract change.

## Surfaces

- CLI: `agenc run start --goal <text> [--cwd] [--model] [--reviewer-model]
  [--max-cost] [--permission-mode] [--verify "label=script"]... [--json]
  [--follow]`; `--model` reaches the run session on start and resume. The
  `run.start` RPC also accepts `provider`. `agenc run status` renders the
  step table; `agenc run evidence` exports the machine-readable bundle.
  After finalize, the delivered commit is `refs/agenc/runs/<runId>`. See
  [cli.md](../reference/cli.md#run).
- SDK: `client.startRun(params)`; attach/replay/result/evidence by run id
  with the existing cursor contract.
- TUI: the run appears on the agents rail like any daemon-owned run.

## Evidence bundle

`agenc run evidence <run-id>` exports the verified-change record and the
ledger artifact set alongside the existing admission evidence. The bundle is
self-contained: hash chain, per-command records, patch and changed-file
digests, review output, spec digest, terminal status, and unresolved risks
are all re-derivable and re-verifiable from the exported bytes alone —
reconstructing what happened requires no daemon, no SQLite, and no trust in
the final prose summary.

`reconstructVerifiedChange(bundleDir)`
(`runtime/src/workflow/evidence-reconstruction.ts`) is the mechanical form of
that claim: it re-validates the record (canonical document digest + spec
binding), verifies the sealed hash chain via `verifyEvidenceLedger` — pinned
by the `evidenceLedger.sealDigest` the completed record now carries and the
bundle's local anchor material — recomputes every artifact digest from the
exact CAS bytes, re-derives the review blockers from the
`independent_review` artifact, and cross-checks the recorded verification
commands against a `test_result` artifact. Any tampered byte fails loudly
with a typed error; a summary is never produced from unverified bytes.

## Operator troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| `plan` dies twice as `step_retries_exhausted` with an empty `final_message` | Pre-#1765: child error was dropped. Current code records `workflow plan child errored: <error>` | Read the child's `finalMessage` / `error`; typical causes are the wrong provider for `--model`, or a model that exhausted recovery before emitting a token |
| `--model` accepted but children hit the daemon default endpoint | Session used to ignore the frozen model/provider | Confirm the CLI `--model` (or SDK `startRun` `model`/`provider`) reached intake; resume re-applies the spec. The CLI has no `--provider` flag |
| `git add` / `index.lock`: Read-only file system | Linked-worktree index lives under the main `.git/worktrees/<slug>/` | Expected path is `runGitMutation` with the git root granted. If this still appears, the sandbox grant is wrong; do not switch the run to a read-only git helper |
| `workflow.review` fails with `no structured ReviewOutput (N chars): <excerpt>` | Reviewer narrated, refused, or was truncated after the one repair turn | The excerpt is the actual reply. Pin a reviewer that can emit `ReviewOutput` JSON; implement/verify already passed |
| Finalize succeeded but `git branch --contains <head>` is empty | The worktree branch is deleted on purpose | The product is `refs/agenc/runs/<runId>`. If that ref is missing, cleanup left the worktree because the pin failed |
| Spawn rejected: `agent_name must use only lowercase letters...` | Child run ids contain `-`, `:`, `#` | `workflowChildAgentName` must fold those to `_`. A raw id is not a valid registry name |
