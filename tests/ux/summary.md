# UX testing summary

10 personas drove `agenc 0.2.0` (HEAD `6ace5164`) through `script(1)` with timed input. Every claim cites a transcript under `tests/ux/runs/`. Full deduplicated list of friction in `tests/ux/findings.md`.

## Top 5 issues to fix first

### 1. The `unsafePeek` family of slash-command crashes
**Hits 5 commands across 5 personas: `/status`, `/usage`, `/effort`, `/model`, `/version`.** Every one renders `Error: Cannot read properties of undefined (reading 'unsafePeek')` in a red user-facing box. Picked first because it's a blocker, hits the early-journey commands a new user reaches for, and is almost certainly a single shared root: a slash-command session shim accessing `<store>.unsafePeek()` where `<store>` is undefined. One nil-guard at the shared call site fixes all five commands. Likely lives near `runtime/src/commands/registry.ts`'s session shim or the per-command session adapter that wraps slash invocations. If the underlying data isn't ready, render an empty-state panel like `/cache-stats` does — that's the template that already works.

### 2. `/help` returns the literal string "registry pending"
**4 personas confirmed; the first command a new user types.** The `/` picker tooltip correctly describes `/help` as "Show help and available commands", and the picker itself proves the registry exists and works. So `/help`'s handler simply isn't reading from it. Fix: wire `/help`'s handler in `runtime/src/commands/help.ts` to the same registry that powers the `/` picker; on `/help <topic>`, fall back to either the index or an explicit "Unknown topic — try `/help`" message. The current `registry pending` text leaks internal state and is the worst possible thing to show a first-time user.

### 3. The "Found 4 keybinding errors · /doctor for details" banner
**10 of 10 personas hit this. Every cold launch. Every screen.** `/doctor` shows the four "errors" are `ctrl+c` and `ctrl+d` declared twice in the shipped default `keybindings.json` and then flagged as reserved/hardcoded. The default config triggers its own warning. Picked third because (a) it's the most-confirmed bug in the entire report, (b) it actively erodes new-user trust on every launch, (c) it's the cheapest fix. Either dedupe the registrations in `runtime/src/tui/keybindings/defaultBindings.ts`, or demote the validator from `error` to `info` when an entry matches its own hardcoded action.

### 4. Ctrl-C never cancels in-flight work, Esc footer hint is a lie
**Critical, mid-task. `[IR]` primary, multiple personas tangentially affected.** Footer says "esc to interrupt" — Esc has no observable effect during streaming or tool calls. Ctrl-C arms an exit warning but a second Ctrl-C neither cancels the turn nor exits. Long-running tools (a `sleep 60` Bash call) cannot be killed at all; the model is even told `write_stdin yield_tim_ms 55000` AFTER both user Ctrl-Cs. This is the issue that makes AgenC feel uncontrollable once a turn is in flight. Fix has two halves: (a) honor Esc as documented (or correct the footer) — this is a small wire-up in `PromptInput.tsx`'s key handler; (b) during a busy turn, treat the first Ctrl-C as cancel-turn (abort the provider stream + SIGTERM the tool process group) and reset the exit counter. The provider-stream abort path almost certainly already exists for shutdown — needs to be reachable from a user Ctrl-C while a turn is active.

### 5. Returning-user path is completely dead
**`agenc -c` and `agenc --resume <id>` both fail with `session not found` for every id the picker advertises.** Plus `/history` silently wipes the active session (it prefix-matches `/clear`), `/version` crashes (prefix-matches `/status`), and Up-arrow does not recall prior prompts. The cumulative effect: a user returning after a week sees a list of past sessions, picks one, and gets nothing — and along the way might lose their current session if they reach for `/history` to find old prompts. The root cause for `--resume` is two parallel project-key schemes under `~/.agenc/projects/`: legacy unhashed `-home-...` and new hashed `home-...-f932f164`. Picker reads the new path, resume reads the old. Unify on one slug. The `/history` → `/clear` collapse is independent: the slash dispatcher prefix-matches unknown commands against existing ones, and `clear` happens to start with `c`. That routing should never resolve unknown commands to destructive ones.

## What worked unexpectedly well — preserve as the codebase evolves

Several things scored 4-5/5 across personas and would be regressions if lost:

- **Paste handling.** Paste-bomber pushed 122KB / 500 lines of mixed code fences, unicode, ZWJ emoji, and 200+ char URLs through the composer. The TUI collapsed it to `[Pasted text #1 +498 lines]` cleanly, no scroll lock, no freeze, and a small-paste round trip through the model came back byte-identical for every Unicode codepoint, RTL glyph, and emoji sequence. The placeholder pattern is the right affordance.
- **`agenc providers` table.** Error-recoverer rated it the best error UX in the entire surface: every row names which env var to set and where each provider lives. Use this as the template for other discovery surfaces.
- **`/doctor`.** Multiple personas independently called this the most polished command. It correctly categorizes sandbox / MCP / keybindings, gives actionable detail for each, and is the single bright spot when something else is wrong. The startup banner correctly points at it.
- **CLI flag rejection.** `--profile nonexistent`, `--model bogus`, `agent attach <missing>` all name the bad input AND the alternatives. Best error UX in the binary. The TUI's slash-command errors should follow the same template.
- **Daemon resilience.** `agenc daemon stop` followed by `agenc agent list` transparently respawns the daemon. No dangling-pid bugs observed.
- **`@-mention` picker.** When used as designed (literal Tab opens it, then arrow + Enter), it handles unicode (kanji, é, 🚀), spaces in filenames, broken symlinks, and 200-file directories instantly. The substrate is solid; the rough edges are around discoverability (bare Tab doesn't open it from text) and ranking (fuzzy beats prefix when prefix would be better).
- **`!` bash mode.** Power-chainer rated it clean: prompt rune flips to `!`, mode is unambiguous.

## Patterns of friction that suggest structural fixes

Three patterns appeared often enough to suggest a single structural change is more valuable than fixing each instance.

**Advertised-but-broken.** `Ctrl+T` is in the `?` overlay as "toggle tasks" but inert. `esc to interrupt` is in the footer but Esc does nothing. `/resume` says "Resume with: agenc --resume <sessionId>" but that command never works. The TUI's hint surfaces don't match its runtime behavior. A single contract test that spawns the TUI, reads every advertised key/command, and verifies each is bound to something would catch all three on a single run.

**Slash-dispatch prefix-matching is destructive.** `/history` resolves to `/clear`, `/version` resolves to `/status`. The dispatcher takes user input, looks for the longest registered command that prefixes it, and dispatches. That's fine for `/co` → `/cost`, but it's catastrophic when the prefix-matched command is destructive or crashes. Replace the prefix matcher with: only autocomplete from the picker; reject unknown literal commands with "Unknown command — did you mean `/clear`? Press Tab for the menu". Same fix kills two of the top-5 friction items.

**Slash commands lack a global error boundary.** `unsafePeek` (5 commands), `newDefaultTurnWithSubId` (`/context`), and `OAuth` errors all leak raw JS exception strings into red user-facing boxes. There is no "command failed: <command>" wrapper anywhere. Wrap every slash invocation in a try/catch that logs the stack to debug and renders a generic "Command failed — see ~/.agenc/daemon.log for details" panel. Six bugs become "we should fix the underlying cause but at least the user sees something sensible".

A fourth pattern, narrower: **The TUI doesn't use width.** Every popover ignores cols beyond ~30. The `/diff` view is the most painful — single-column when side-by-side is the canonical wide-width win. A single layout primitive that caps card width at `min(120, cols-8)` and offers two-pane mode at `cols >= 160` would unlock value across `/help`, `/diff`, `/permissions`, `/files`, and `/cache-stats`.

## Failed personas

None failed entirely. All 10 produced reports within the 800-word cap. Two minor caveats:

- **Error-recoverer's "network down" scenario was inconclusive.** Setting `OPENAI_BASE_URL=http://localhost:1` and replacing the LMStudio base URL with a dead port still produced model replies on `--no-tui`, suggesting the daemon either cached a worker or short-circuited the prompt. Not raised as a defect, but the actual "model unreachable" UX path was not exercisable from this run.
- **Returning-user noticed `~/.agenc/config.toml` parse errors emitted by parallel one-shots even though the file inspected clean** — likely concurrent rewrites by sibling personas hitting a shared daemon. A daemon-shared-state concern visible as test cross-talk, not a defect attributable to any single persona.
