# Persona: Error Recoverer

## Task
Trigger 7 classes of error condition against `agenc` 0.2.0 (CLI + `--yolo` TUI) and grade whether the surface explains what went wrong, suggests recovery, and keeps the user productive without restart. Driven via `script -q` from `/home/tetsuo/git/AgenC/agenc-core`. Verbatim transcripts captured in `error-recoverer-screen.log` (line refs cited below).

## Outcome
The CLI side handles errors well: precise wording, names the bad input, lists alternatives. The TUI side is a mixed bag — two real defects found (`/model` crashes with `unsafePeek`, `/help <arg>` shows only `registry pending`), and a few cases where the runtime carries on without telling the user it fell back to defaults. The user is never forced to restart; ctrl-c twice always exits cleanly. Daemon recovery is excellent — auto-respawns on next call.

## Friction log

- **CRIT / TUI / `/model nonexistent-model-xyz`** (screen.log L8-13). TUI prints `Error: Cannot read properties of undefined (reading 'unsafePeek')`. That's a JS exception message bubbling up — not a "model not found" message. **Expected**: "Unknown model 'nonexistent-model-xyz'. Run `/models` to list available." **Repro**: launch `agenc --yolo`, type `/model bogus`, Enter. **Fix**: guard the model-lookup call before dereferencing whatever stream/peek primitive is failing.

- **HIGH / TUI / `/help nonsense`** (screen.log L44-46). TUI prints just `registry pending` in a panel. No indication that `nonsense` is unrecognized, no fallback to general help. **Expected**: Either ignore the argument and show full help, or "Unknown help topic 'nonsense'. Try `/help` for the index." **Fix**: handle subcommand args in the help slash handler; surface a real "topic not found" path.

- **HIGH / CLI / corrupt `~/.agenc/config.toml`** (screen.log L85-89). The TOML parse error message is good (`expected '=' after key "this"`), but it is **emitted 5 times in a row** (twice per code path, three load passes), then the runtime silently continues with built-in defaults and gives a normal-looking model reply. **Expected**: emit the parse error once, then "Falling back to defaults — fix config.toml or run `agenc config init`." **Fix**: dedupe the warning, and add a single explicit "using defaults" notice so the user knows their config did not load.

- **MED / TUI / @-mention to missing path** (screen.log L34-37). TUI sends `@/does/not/exist.md explain this` to the model verbatim; only the model's own polite reply tells the user the file was missing. **Expected**: a TUI-level pre-send check + inline annotation ("file not found, sending text only") so the behavior doesn't depend on whichever model happens to be loaded. **Fix**: resolve `@`-paths in the composer; flag missing ones before submit.

- **MED / TUI / `/   ` (slash + only whitespace)** (screen.log L48). Auto-completes to `/agents` and submits silently. No "empty command" feedback. **Expected**: trim the input, and either reopen the slash menu or do nothing on whitespace-only. **Fix**: short-circuit submit when the trimmed command is empty.

- **LOW / TUI startup / persistent banner** every run shows `Found 4 keybinding errors · /doctor for details` (screen.log L46, L52, L57). Not strictly an "error scenario" trigger — it's there on every cold start. **Expected**: keybindings ship clean, or the banner self-clears once acked. **Fix**: fix the four bindings (or surface them via `/doctor` only).

- **LOW / TUI suggestion menu** when `/totally-not-a-command` fails (screen.log L39-41), the response is rendered as a raw JSON blob: `{ "kind": "error", "message": "Unknown command: /totally-not-a-command" }`. Wording is correct, but the JSON envelope leaks where a one-line error pill would do. **Fix**: render the `message` field as plain inline error.

- **INFO / Network-down test inconclusive**. With `OPENAI_BASE_URL=http://localhost:1` (T2) or LMStudio `base_url` rewritten to a dead port (T2b), `--no-tui` still answers (screen.log L15-32). Either the daemon is short-circuiting common prompts or it cached a worker process holding the prior config. Not a reproducible failure, so not raised as a defect — but it does mean the actual "model unreachable" UX path was not exercisable from this run.

## What worked well

- **`agenc providers`** (screen.log L55-74) is exemplary: every row tells you exactly which env var to set. Best error UX in the surface.
- **`--profile nonexistent-profile`** (screen.log L82): `Unknown profile "nonexistent-profile". Available: <none>` — names the bad value and the alternatives.
- **`--model` flag rejection** (screen.log L2-7): explains the flag isn't supported, points at config.toml AND `agenc config set`. Two recovery paths.
- **`agent attach nonexistent`** (screen.log L80): `daemon agent not found for attach: nonexistent` — clear, names the input.
- **Daemon resilience**: `agenc daemon stop` then `agenc agent list` — the latter respawned the daemon transparently. No dangling-stale-PID class of bug observed.
- **Ctrl-C twice exits cleanly** in every TUI failure mode tested. No hang, no terminal corruption.

## Discoverability score: 3/5
CLI errors point at the next action; TUI errors usually do not. `/help <bad-topic>` returning `registry pending` is the worst offender — the user is left with nothing to try.

## Latency feel: 4/5
All errors surface within ~1s of the trigger. Daemon stop/restart is invisible to the user. No spinner-stuck states observed.

## Error message quality: 3/5
CLI quality is 4-5/5; TUI quality is 1-2/5. Two bare exceptions (`unsafePeek`, JSON-blob wrapping for unknown slash) and one dead-end (`registry pending`) drag the average down.

## Notable surprises
1. The `/model` slash command appears to invoke a code path (`unsafePeek`) that is not defensive — could indicate a missing wiring rather than just bad input handling.
2. `--no-tui "hi"` returns a canned-feeling reply even with the configured provider URL pointing at port 1. Worth verifying whether that path actually round-trips to the model or gets short-circuited.
3. Corrupt config emits the same parse error 5x — log volume bug.
4. Daemon comes back automatically on next CLI command. No user message about the respawn — silent recovery is good, but a one-line "(daemon restarted)" would build trust.
5. All cleanup verified: daemon running (`pid 66641`), `~/.agenc/config.toml` restored to original LMStudio config.
