# Returning-User UX Report — agenc 0.2.0 @ 4999c596

Persona: returning user, week away, wants the last session, a recalled
prompt, and what changed. Lab: `--yolo` driven via `script` + xterm key
codes. One-shot seed (`--no-tui "echo task one"`) hung past 90s under
parallel daemon thrash and was killed. The pre-existing
`~/.agenc/history.jsonl` (916 lines) and ~80 sessions provided baseline
state. Citations are line numbers in `returning-user-screen.log`.

## What works

- **`/resume` lists sessions.** A modal overlay renders timestamp, session
  ID, preview snippet, and rollout filename for the latest 8 conversations,
  ending with the footer `Resume with: agenc --resume <sessionId>`
  (line 3). Sorted newest-first. Most rows show `(no preview)`.
- **`/rewind` is a real command.** Suggestion line "Restore the code and/or
  conversation to a previous…" shown when typed (line 18). Did not exercise
  the inner UI in this run.
- **`/status`** renders a real panel (line 23): `SessionID:
  agenc-tui-idle-256582`, `CWD: /home/tetsuo/git/AgenC/agenc-core`, `Model:
  unknown`, `Provider: lmstudio`, `Turn count: 0`, `Tokens emitted: n/a
  (budget disabled)`, `Permission mode: default`.
- **`/release-notes`** opens the `CHANGELOG.md` viewer in a dialog
  (line 28). Content is real but stale (`[Unreleased]`, `[0.1.0]
  2026-02-14`).
- **Up arrow recalls prompt history across sessions.** Three sequential
  Up presses surfaced `/release-notes`, `statu`, `rewind` (line 45) — none
  of which were entered in the current session. A hint
  `ctrl+r to search history` is printed inline on the composer
  (line 45).
- **Ctrl+R opens a "Search prompts" overlay** with a filter box, a list of
  recent prompts annotated with relative timestamps (`3m ago /resume`,
  `2m ago /knowledge`, etc.), and live filtering — typing `show` narrowed
  the list to a 10-minute-old "write a long essay…" entry (line 50). Cross-
  session, works.
- **`agenc agent list`** (CLI subcommand) prints a TSV of conv IDs and
  their seed objective text, including phantom rows that still say
  `status: running` even though the daemon does not have those sessions in
  memory.

## Critical findings (returning-user blockers)

1. **`agenc -c` (continue latest) is broken.** Exits immediately with
   `agenc: session not found: conv-mp0778p7` (line 33). It picks the most
   recent ID from history but cannot locate the session record. The `-c`
   flag is the documented one-keystroke return-to-work path; today it is
   100% failure for this project.
2. **`agenc --resume <id>` is broken with the same error path.** Tested
   against `conv-moz9tn9u`, which has a real rollout file on disk
   (`~/.agenc/projects/tmp-agenc-spin-gate-…/sessions/conv-moz9tn9u/rollout-…
   .jsonl`). Result: `agenc: session not found: conv-moz9tn9u` (line 39).
3. **`/resume` and `--resume` are split-brained.** The `/resume` modal
   reads from one location (it lists rollouts and shows them as resumable);
   the `--resume` CLI dispatcher reads from another (rejects the same
   IDs). Net effect for a returning user: the picker hands you an ID,
   tells you to run `agenc --resume <id>`, and the command then refuses
   that ID. Critical — this is the primary returning-user contract.
4. **`/sessions` and `/history` do not exist as commands.** Typing them
   triggers the fuzzy-match fallback. `/sessions` matches `resume /
   permissions / status / color / cache-stats` (line 8); `/history`
   matches only `/clear` ("Clear session history and caches", line 13).
   Both names are extremely natural guesses for this persona; both lead
   to dead ends.
5. **Project sessions do not persist rollouts.**
   `~/.agenc/projects/-home-tetsuo-git-AgenC-agenc-core/` has only
   `conv-mp02dbpp/session-memory/summary.md` and
   `conv-mp029yr6/session-memory/summary.md` — no `rollout-*.jsonl`.
   Rollout files only exist under `tmp-agenc-*` ephemeral project paths.
   So even if `--resume` were fixed, there is nothing for it to load
   from this real project anyway.

## High-priority issues

- **`/status` shows `Model: unknown`** despite `agenc config get model`
  returning `qwen3.6-35b-a3b-fp8` and the daemon being healthy. Returning
  user cannot confirm what model is selected (line 23).
- **`/status` reports the synthetic `agenc-tui-idle-256582` Session ID
  instead of a real conv ID** at idle (line 23). Returning user has no
  way to learn the current session's resume key without sending a
  message first.
- **Session list rows show mostly `(no preview)`** (line 3) — eight
  rows, only one ("hi") has any preview text. Hard to identify "the
  thing I was doing."
- **`agent list` reports stale `status: running` for clearly dead
  sessions** spanning 18:58–20:01 — the harness rolls forward without a
  daemon-side reaper. Looks deceptive to a returning user.

## What's-new surface

`/release-notes` is the only what's-new affordance. Its content advertises
this build as `[Unreleased]` and last shipped `[0.1.0] 2026-02-14`, while
`agenc --version` says `0.2.0` (line 28 vs. CLI). Mismatch. There is no
`/changelog`, no first-run "what changed since you were here" toast, and
no `--version --verbose` output. The release notes still mention Solana-
era `acceptedMints` / `rewardMint` deprecations (line 28), which is also
stale messaging for a returning user trying to gauge product direction.

## Notes

- One-shot seeding hung at 90s under parallel daemon restart; existing
  history sufficed for persona coverage.
- Did not enter the `/rewind` inner flow.
