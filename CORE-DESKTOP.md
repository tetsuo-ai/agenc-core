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

## History

| Date | Commit | Change |
| --- | --- | --- |
| 2026-11-19 | `647d4c4a4` | Created from `main` (0.19.38). |
