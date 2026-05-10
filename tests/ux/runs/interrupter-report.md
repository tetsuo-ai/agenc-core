# Persona: Interrupter

## Task
Drive `agenc --yolo` via `script` + `timeout` and probe interrupts:
Ctrl-C mid-stream (single + double), Ctrl-D (empty / non-empty /
double), Ctrl-Z, Ctrl-L, Ctrl-C during a slow tool, Ctrl-C while
typing, Esc during streaming, Ctrl-C in the slash menu. Verify prompt
recovery, partial-state preservation, daemon zombies.

## Outcome
Most key bindings produce surprising results. The footer hint says
`esc to interrupt`, but neither Esc nor Ctrl-C interrupts streaming or
running tools. The "Press Ctrl-C again to exit" affordance fires, but a
second Ctrl-C does NOT exit during a turn — it just re-arms. Double
Ctrl-D from an empty composer is the only key combo that cleanly kills
the TUI. Every aborted run leaves a `running` agent on the daemon.

## Friction log
- **CRITICAL / streaming + tools / single Ctrl-C does not cancel /
  Expected: stop streaming or kill tool / Repro: keys.log L5 (essay
  finishes after Ctrl-C), L26 (`sleep 60` keeps running, model then
  issues `write_stdin yield_tim_ms 55000`) / Fix: bind Ctrl-C while
  busy to abort provider stream + SIGTERM the tool child group.

- **CRITICAL / streaming / double Ctrl-C does NOT exit AND does NOT
  cancel / Expected: first Ctrl-C cancels turn, second exits / Repro:
  L8 — both warnings shown, full essay still completes, prompt only
  returns after the model finishes / Fix: during a busy turn, treat
  the first Ctrl-C as cancel-turn and reset the exit counter.

- **HIGH / running tool / no way to kill a long Bash tool / Expected:
  Ctrl-C cancels child + finalizes ToolCallRecord as cancelled / Repro:
  L26 / Fix: wire SIGINT/SIGTERM to the exec process group on Ctrl-C.

- **HIGH / Esc during work / hint says "esc to interrupt" but Esc has
  no observable effect / Repro: L35, `Masking…` spinner runs through
  Esc / Fix: honor Esc as the documented interrupt, or correct the
  footer hint.

- **HIGH / daemon zombies / aborted Ctrl-C runs leave `running` agents
  forever / Repro: `agenc agent list` after run showed my
  `conv-mp02f93v` (sleep 60) and `conv-mp02ekrl` (find /usr) still
  running despite TUIs being killed / Fix: TUI sends `cancel` on
  shutdown, OR daemon reaps conversations on socket disconnect.

- **MEDIUM / empty composer / Ctrl-D shows warning but the second
  must come within ~500ms with no countdown / Repro: L11 vs L14
  (single = stuck, double-fast = exit 0) / Fix: footer countdown like
  Ctrl-C handling.

- **MEDIUM / non-empty composer / Ctrl-D is a silent no-op / Repro:
  L17 / Fix: flash cursor or display hint.

- **MEDIUM / Ctrl-Z / silently eaten, no suspend, no error / Repro:
  L20 / Fix: document or implement; eating SIGTSTP silently breaks a
  long-standing terminal contract.

- **MEDIUM / Ctrl-C while typing / silently clears composer AND arms
  exit-warning / Repro: L32 ("half typed message" gone, exit warning
  shown) / Fix: when composer has text, Ctrl-C clears buffer only;
  arm exit-warning only on a subsequent empty Ctrl-C.

- **MEDIUM / Ctrl-L / redraw works, but stamps "Found 4 keybinding
  errors · /doctor for details" over the redrawn frame / Repro: L23
  / Fix: emit the warning only at startup.

- **LOW / startup / "Found 4 keybinding errors · /doctor for details"
  on every launch / Repro: every scenario / Fix: ship defaults that
  pass `/doctor`, or surface the four errors inline.

## Discoverability score: 2/5
Footer says "esc to interrupt" but Esc does nothing and Ctrl-C is the
actual (broken) interrupt. Slash menu discovery is fine.

## Latency feel: 3/5
Pre-stream "Throttling / Masking / Tabulating" phase often runs 4-8s
before any visible token, with only a spinner.

## Error message quality: 2/5
"Press Ctrl-C again to exit" lies — pressing again does not exit
during a turn. The keybinding-errors banner shows zero detail.

## Notable surprises
- Double Ctrl-C does NOT cancel an in-flight turn, contradicting
  nearly every CLI convention.
- Ctrl-C inside the slash menu cleanly closes it (this works well).
- The model is told to wait when the user wants to abort: `write_stdin
  yield_tim_ms 55000` is issued AFTER both Ctrl-Cs.
- Daemon cleanup done: `agenc agent stop conv-mp02f93v
  conv-mp02ekrl` both reported `stopped`. Sibling-persona zombies left
  in place.
