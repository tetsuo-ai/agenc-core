# Persona: Narrow Terminal (80x24)

## Task
Drive `/home/tetsuo/.local/bin/agenc --yolo` (agenc 0.2.0) inside `script(1)` with `stty cols 80 rows 24` forced before exec. Open the slash menu, run a representative slash-command set, type a 200-char prompt, submit a multi-line prompt, and inspect footer/help. Compare with `agenc --no-tui` one-shot. Every claim cites the captured screen log at `tests/ux/runs/narrow-terminal-screen.log` (`screen.log`).

## Outcome
TUI starts cleanly at 80x24 (visible 80-column rule + composer + footer; screen.log L4-7). Three commands return runtime errors, one is registry-pending, one is misrouted, one launches `nano` full-screen. Slash-menu descriptions truncate. A persistent footer warning ("Found 4 keybinding errors · /doctor for details") consumes a top row. No crash; agenc remained interruptible via double Ctrl-C in all 18 runs.

## Friction log

- **HIGH** / `/help` / Returns a panel containing only `registry pending` (screen.log L13-16). Expected: command list/description. Repro: type `/help` + Enter. Suggested: ensure command-help registry is initialized before TUI command surface accepts input, or fall back to in-process registry.
- **HIGH** / `/status` / Panel: `Error: Cannot read properties of undefined (reading 'unsafePeek')` (L23-26). Same crash for `/effort` (L97-100) and `/usage` (L122-125). Expected: status/effort/usage values. Repro: invoke any of those three. Suggested: nil-guard the shared `unsafePeek` accessor, or print a friendlier "session metrics not yet available" message.
- **HIGH** / `/buddy` / Panel: `{"kind":"error","message":"/buddy requires the interactive TUI command surface."}` while we ARE in the interactive TUI (`agenc --yolo`, L66-70). Expected: open buddy UI. Repro: `/buddy`+Enter. Suggested: fix the TUI-detection check used by the buddy command; it is rejecting its own host.
- **HIGH** / footer / `Found 4 keybinding errors · /doctor for details` is rendered above the top rule on every screen (L4, L13, L23, L33, L66, L76, L97, L107, L122). `/doctor` reveals duplicates: `ctrl+c` and `ctrl+d` listed twice as reserved/hardcoded (L132-141). Expected: no diagnostic noise on a clean install. Suggested: dedupe the reserved-key check, or downgrade `reserved` violations from "error" to "info".
- **MEDIUM** / slash menu / Description column truncates at ~46 cols with `…`. Examples: "Create a branch of the current conversation at th…", "Ask a quick side question without interrupting th…", "Show uncommitted changes (git diff HEAD + untrack…", "Copy the latest message or transcript text to the…" (L7, L34, L57, L122). Expected: legible help text or a wider descriptor at 80 cols. Suggested: shorten descriptions to ≤45 chars for narrow widths, or wrap into a second line.
- **MEDIUM** / `/keybindings` / Spawns `nano` over the entire 80x24 viewport, replacing the TUI without warning; on exit, returns to TUI (L77-91). Expected: confirm-prompt or scoped editor pane. Suggested: prompt `Open ~/.agenc/keybindings.json in $EDITOR? [y/N]` or use a built-in form.
- **MEDIUM** / multi-line response in TUI / 30-second wait on a real prompt produced output that got squeezed into stretched rows with collapsed inter-word spacing visible in the captured stream (L116-121). Hard to confirm whether this is a true layout bug or a `script(1)` artifact at narrow widths; one-shot via `--no-tui` wraps cleanly (L142-156). Suggested: regression-test multi-paragraph rendering against a fixed-size pty and confirm word-spacing preserved.
- **LOW** / `/diff` / Box content like `(no changes)`, `# untracked files`, file names render fine, but the lead-in spinner overlaps the bottom border before settling (L57-65). Mostly cosmetic.
- **LOW** / help overlay (`?`) / Multi-column shortcuts crowd at 80 cols; some pairs overlap visually (e.g. `& for backgroundedits`, `meta + p to switch model`, `ctrl + s to stash prompt`) (L160-165). Expected: single-column or scrollable list when COLUMNS<100.
- **LOW** / 200-char prompt input / Wraps cleanly across composer rows (L106-111). No line-count indicator visible. Suggested: show `(Lc/Tc)` or character count when prompt exceeds one row.

## Discoverability score: 2/5
Slash menu opens reliably and lists most commands, but ~6 of 13 tested commands fail or misbehave. Truncated descriptions and the missing `/help` text make it hard to learn the surface from inside the narrow TUI.

## Latency feel: 3/5
Slash menu reaction is instant. `/diff`, `/permissions`, `/files` respond in <1s. Prompt streaming begins within ~3s. `/doctor` takes ~4s.

## Error message quality: 2/5
`unsafePeek` and `/buddy requires the interactive TUI` leak internal state to the user with no remediation path. `/help` returning `registry pending` is opaque. The doctor output IS clear and actionable — that is the bright spot.

## Notable surprises
- `/help` is broken on a fresh narrow-TUI session.
- `/buddy` thinks it isn't running in a TUI even though it is.
- The keybinding-error footer is permanent on every screen due to a stale duplicate check that should never fire.
- One-shot (`--no-tui`) wrapping is markedly cleaner than the TUI's, suggesting the layout engine, not the terminal, is the bottleneck at 80 cols.
