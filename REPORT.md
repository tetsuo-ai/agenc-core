# PR #2811 final validation — 2026-09-29

Completed the operator's final decisions on `fix/delegation-e2e`.

## Changes

- Replaced `completedTaskResults` with a 1 MiB LRU cache per reusable worker. Accounting includes key and answer storage plus entry overhead; oversized answers remain journal-only. Eviction never deletes the durable receipt.
- Evicted results use immutable turn references to read the journal. Live workers read through their existing journal owner with inode/snapshot checks; stopped workers retain the leased recovery path. Targeted reads collect only the requested turn, including beyond the bulk reader's 1,024-receipt limit. Existing journal validation, authorization, byte and time limits remain in place.
- Removed the natural-language exact-output detector and its regexes. The completion checklist exemption now requires `exactOutput` on the turn/session, or the headless CLI's `json` / `stream-json` format. CLI continuation carries the setting per turn. Ordinary requests mentioning JSON retain main's completion-gate behavior.
- Added `exact_output` to `spawn_agent` and `assign_task`, scoped to that child task, and prompt guidance telling parents to set it for verbatim JSON. Child results always reach the parent verbatim, including paged results. Other delegation, truncation-recovery and result-transport fixes remain intact.

## Validation

**21 focused files, 1,569 tests passed.** Coverage includes 48 assignments on one reusable worker with eviction and retrieval from its still-live journal; LRU/empty/oversized result accounting; retrieval after 1,030 durable outcomes; source replacement and closed-journal refusal; explicit JSON preservation through child and parent; ordinary JSON requests retaining the checklist; and both headless JSON output formats.

Standard Linux `npm --workspace=@tetsuo-ai/runtime run typecheck` passed, including test-support checks. The standard Linux runtime build, declaration emission, package entrypoints and regenerated SDK wire-type checks passed. Local runtime and test-support typechecks passed with `--preserveSymlinks` for the shared dependency layout. `git diff --check` passed. No full-suite result is claimed.

## Real Linux daemon check

The same eight frozen router-bench tasks ran once each on the Linux PC: four calibration and four previously used held-out tasks. Parent: native DeepSeek `deepseek-flash`; child: unchanged fixed native Meta `muse-spark-1.2-contributor`. Tasks, graders and candidates were unchanged. Runs used the existing daemon harness with `--output-format stream-json`, a 4,096-token output cap, at most eight parent/four child calls, one child and depth one. No model-answer reruns or outcome-based task changes were made.

**Strict E2E: 7/8. Child correctness: 7/8. Successful child completion, exact receipt delivery and byte-for-byte parent final preservation: 8/8 each.** All transport/constraint checks passed. No completion checklist was injected; all 26 parent requests left tool choice to the model.

| Task | Strict E2E | Child correct | Exact receipt and parent final |
|---|---|---|---|
| cal-simple-extraction | pass | pass | pass |
| cal-code-stable-unique | pass | pass | pass |
| cal-tool-invoice-join | pass | pass | pass |
| cal-long-revision | pass | pass | pass |
| hold-simple-extraction | pass | pass | pass |
| hold-code-window-max | pass | pass | pass |
| hold-tool-artifact-manifest | fail | fail | pass |
| hold-long-precedence | pass | pass | pass |

The single failure, `hold-tool-artifact-manifest`, was an incorrect child answer (`answer-mismatch`). Both child and parent returned `{"count":12,"ids":["b","a","c"]}`; transport preserved it exactly. The two long-context tasks each recovered a truncated initial tool call via `message_ref`, then completed successfully. This small check measures the requested transport behavior and does not establish a broader model-quality rate.

| Provider | Calls | Known usage estimate (USD) | Conservative exposure (USD) |
|---|---:|---:|---:|
| deepseek | 26 | 0.02959828 | 0.08913210 |
| meta | 11 | 0.00891736 | 0.01903600 |

Total known usage estimate: **$0.03851563**. Conservative exposure: **$0.10816810**, below the **$1 aggregate admission cap**. All 37 requests settled with reported usage; none remains in flight. These are usage-based estimates, not exact billed totals. The existing cumulative ledger and provider ceilings were preserved. Credentials were read in memory and supplied only through SSH stdin into process environments. Per-run scans and the final Linux artifact scan found zero key matches/redactions and zero unreadable files. All eight isolated daemons stopped successfully and their recorded PIDs no longer exist.

## Evidence and source identity

The Linux build used base `118873e1502e81f051cbffdfcf2e7df0bdd1267f` plus the pre-commit source changes in this PR. The 36 changed/new source and test files and the detector deletion were verified against this worktree before paid calls. Source snapshot digest: `55d3ac2f155bf44d8ccff8cebf7436fe2685ed3203179f4b3796c17899f53be3`. The report itself was written after the run.

Local evidence is under `/private/tmp/e2e-delegation/`: `final-round-results.json`, `final-round-final-tests.log`, `final-round-linux-build.log` (standard typecheck; initial build required SDK regeneration), `final-round-linux-build-final.log` (successful build), `final-round-source-verification.log`, `final-round-cleanup.json`, `final-round-key-scan-pc.json`, and `final-harness/manifest.json`. The manifest's copied prior-round labels were corrected without changing task/run IDs, source/task hashes or budget settings. Linux artifacts are under `/home/paul/claude-agenc-work/e2e-delegation/runs/r7-01` through `r7-08`; the isolated source checkout is `final-core`.

## Paired Linux regression follow-up — 2026-09-29

Investigated both failures from `core-2811-focus.log` against main `3caa13df9d56d1623766096f013e8ffc7e54c043`. Neither requires a product-code change:

- **`assign_task returns correlation for an idle reusable worker`: stale argument assertion.** The branch deliberately passes `exactOutput: false` when `exact_output` is omitted. Each assignment has its own output contract; an ordinary follow-up must not retain a previous assignment's exact-output exemption. Updated the exact call assertion to include the explicit false value. Existing `send-message.test.ts` coverage verifies true, subsequent omission/reset, and invalid input; the focused assertion and contract tests both passed locally.
- **`CronDelete cancels a queued turn without suppressing another scheduled tool turn`: pre-existing fake-clock/real-I/O race.** The test's `advance()` uses ten 5 ms real-I/O polling sleeps. A cancelled durable claim can settle later, retire the old tick, and re-arm the survivor on a due-now timer. `scheduler.drain()` waits for that tick but does not fire its newly created timer, so the assertion can observe zero tool calls. The scheduler and session scheduler are unchanged from main. A diagnostic 250 ms delay in cancelled-submit rejection reproduced the same failure on both refs: one model sample, one pending timer, and `nextWakeInMs: 0`. Waiting for cancellation/re-arm before advancing the clock passed the same delayed probe with three model samples, one survivor tool call, and no pending timers. The committed test now observes the cancelled submission entering the queue and drains its tick before advancing again. All cancellation, survivor-message, tool-count, and model-count assertions remain intact; the diagnostic delay/logging are not committed.

Ran the requested PC helper with `tests/bin/model-facing-tools.test.ts tests/session/run-turn.test.ts`:

| Ref / tested source | Result | PC log label |
|---|---|---|
| Main `3caa13df` | 2 files, 257 tests passed, zero failures | `core-2811-regressions-main` |
| Branch `aa2fc3fb` plus this commit's two test edits | 2 files, 259 tests passed, zero failures | `core-2811-regressions-fixed-branch` |

The final main helper invocation, `core-2811-regressions-fixed-main`, reused the fresh same-commit/same-scope baseline above according to the helper's shared-host guard. The branch has no failures absent from main. The PC test files matched this worktree byte-for-byte before validation (SHA-256: model-facing tools `920b9a0d429f2b8273cad397c6d594e296d9a62a7d2544d7ea19b7f602afe8d8`; run-turn `6fbbd478234df5e6a2505f34ab49b1fb92e8884832fb0999f4a9edd13b1ed524`).

Core typecheck, including `typecheck:test-support`, passed on the PC in `node:26.5.0-bookworm` using npm 11.17.0 (`core-2811-regressions-typecheck.log`). `git diff --check` passed.

Evidence is in `/home/paul/claude-agenc-work/results/`: the paired logs above, `core-2811-regressions-fix.patch`, `core-2811-regressions-typecheck.log`, `core-2811-cron-delay-branch.log`, and `core-2811-cron-delay-fixed.log`. The intentionally failing main diagnostic and delayed-probe patch are in `core-2811-diagnostics/`, outside the helper's reusable main-baseline cache. Temporary diagnostic edits to main were restored.
