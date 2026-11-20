# core-desktop

This branch is the Core that AgenC Desktop runs. It was created from `main`
at `647d4c4a4` (runtime 0.19.38) on 2026-11-19.

## Why it exists

- `main` is the Core that the CLI releases ship. Desktop needs some Core
  changes before `main` takes them, and some that `main` may never take.
- Desktop must not pick up a `main` change before Desktop has been checked
  with it.
- One named branch makes it clear which Core a Desktop build contains.

## Rules

- Desktop's Core work goes here: open its pull requests against
  `core-desktop`, not `main`.
- `core-desktop` is never merged into `main`. A change that `main` should
  also have goes to `main` through its own pull request.
- `main` comes into `core-desktop` only on purpose, when the maintainers
  agree. Merge a chosen `main` commit, then run Desktop's checks before
  Desktop pins it: the unit suite, the e2e drivers and the live app.
- Desktop pins one commit of this branch in
  `packaging/private-core-source.json` (agenc-desktop). The pin's
  `runtimeVersion` is the `version` in `runtime/package.json` at that commit.
- Never force-push this branch, and never rewrite its history.
- FND benchmark baselines (`runtime/benchmarks/fnd/`) are captured for this
  branch's own head and checked against `origin/core-desktop`, never `main`
  (`BENCHMARK_DEFAULT_BRANCH` in `provenance.mjs`; the FND contract test fails
  without it). A change to a file a benchmark loads leaves that test red until
  this branch recaptures: see "The core-desktop line" in
  `runtime/benchmarks/fnd/README.md`.
- `platform-tests` (the full suite in four shards, the FND fresh-clone lane
  and the platform lanes) runs on every push to this branch, as it does for
  `main`.

## History

| Date | Commit | Change |
| --- | --- | --- |
| 2026-11-19 | `647d4c4a4` | Created from `main` (0.19.38). |
| 2026-11-19 | `65775d96e` to `d29b622db` | Desktop's Core pull requests merged: #3611 (timeline capabilities, transcript schema 3), #3609 (a resumed chat keeps its state in its rollout's project), #3610 (a split run reads, marked partial), #3607 and #3612 (a resumed session's whole cost, kept through a crash), #3608 (`session.compact`), #3603 (Goal worktrees on macOS). Protocol 1.37.0. FND baselines bound to this branch. |
| 2026-11-20 | `c3de8b75a` to `dae15d07b` | The w21 Core fixes merged: #3616 (a compacted chat's actions read; RUN_ID_AMBIGUOUS says why), #3613 (compacted chats stay readable; `COMPACTION_RECORD_DAMAGED`), #3615 (patch file names in schema 3, the Goal folder, a replaced call's cost, `platform-tests` on this branch), #3617 (a continued reply kept whole; an automatic compaction reported where it commits), #3614 (DeepSeek keeps its connection between turns), #3618 (macOS full-access and escalated commands with no dialogs; no keychain for sandboxed commands), and `fix/w21-model-lists` (the provider model lists as served on 2026-11-20). Protocol 1.37.0. |
