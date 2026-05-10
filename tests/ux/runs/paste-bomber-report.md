# UX Round 2 — Paste Bomber

**Target:** `/home/tetsuo/.local/bin/agenc --yolo` (agenc 0.2.0, HEAD `4999c596`)
**Date:** 2026-05-10
**Persona:** Paste Bomber — shove a 500-line adversarial markdown blob at the TUI.

## Task

Generated `/tmp/big-paste.md`: 500 lines, ~29.6 KB. Contents: five well-formed fenced code blocks (JS, Python, Rust, nested-fence-via-4-backtick, bash with >300-char lines), four malformed fences (unclosed, mismatched indent, tilde↔backtick crossover, re-opening triple), CJK + Arabic RTL + Hebrew + Cyrillic + Greek + math + ZWJ-sequence emoji + zalgo + fullwidth/halfwidth + box-drawing, a markdown table with mixed-width cells, two URLs >200 chars, an HTML/XSS-shaped block, heading depths 1–7, deeply nested lists. Built `/tmp/small-paste.md` (50 lines) as baseline. Drove `agenc --yolo` under `script(1)` with bracketed-paste markers (`\x1b[200~ … \x1b[201~`), submitted Enter, exited with double Ctrl-C.

## Outcome

TUI did not crash, did not freeze, did not drop input, did not mojibake. Composer collapsed the entire 29.6 KB blob into a single placeholder chip `[Pasted text #1 +499 lines]` (`paste-bomber-screen.log` line 2). The placeholder rendered identically for the 50-line baseline (`[Pasted text #1 +49 lines]`) — chip scales linearly. Enter submitted cleanly; agent responded with a normal "I see this is a large test document…" reply (`screen.log` line 2, after `Exfiltrating…` spinner). Bracketed-paste write completed in **1 ms** (run-timing markers `1778443037.343703` → `…344823`). No detectable freeze. No scrollback corruption. Double Ctrl-C exited with `COMMAND_EXIT_CODE=0`.

## Friction log

- **F1 (Minor, cosmetic):** First-paint toast collision visible in raw `paste-bomber-keys.log`: `Pasting text…  [Pastedtext#1+499lines]` with spaces collapsed in the toast strip (`screen.log` line 2 near "Pasting text…"). Steady-state chip below renders with proper spacing. In-flight layout race only; not user-blocking. Toast also lists line count only, no byte or char hint.
- **F2 (HIGH RISK):** First attempt (no bracketed-paste markers, payload sent as ordinary stdin, see discarded `/tmp/paste-big.log`) caused the TUI to receive bytes as typed input and immediately fire side-effects: `Write({"file_path":"/workspace/past_bomber.md", …})`, `exec_command({"cmd":"pwd"})`, `exec_command({"cmd":"ls /home/tetsuo/git/AgenC/agenc-core/"})`, `TodoWrite(...)` — all in YOLO mode, all before any Enter was sent. Once markers were added it disappeared. **Risk surface:** terminal multiplexers that strip `\x1b[200~`/`\x1b[201~` (older tmux, some SSH chains, some pty wrappers) cause large pastes in `--yolo` to be interpreted as typed input + auto-submit, triggering uncontrolled tool execution. YOLO has no confirmation gate.
- **F3 (Cosmetic):** Spinner labels randomized for personality (`Multiplexing…`, `Injecting…`, `Transcoding…`, `Exfiltrating…` across four runs). `Exfiltrating…` next to a fresh paste of user content is an unfortunate accidental signal.
- **F4 (Cosmetic):** Exit footer prints `PressCtrl-C again to exit` then `PressCtrl-D again to exit` — the next-key hint changes mid-quit. Slight inconsistency.
- **F5 (Not a bug, capture artifact):** ANSI-stripped screen.log shows words running together (`Howwouldyoulikemetohandlethis`). TUI uses `\r`-overwrite diff rendering, inserting spaces via cursor positioning rather than literal space bytes; naive `sed` ANSI strip drops them. Confirmed via `od -c` on raw keys log — no user-visible character loss.

## What I did NOT observe (positive findings)

No scroll lock, no input dropping, no >2s freeze, no malformed-fence crash, no mojibake on CJK/RTL/Cyrillic/ZWJ-emoji/zalgo/fullwidth, no truncation of long URLs from the composer perspective (URLs live inside the opaque chip), no renderer panic on unclosed/mismatched/re-opening fences. 50-line baseline behaved identically structurally; no scaling cliff between 50 and 500 lines.

## Scores

- **Renderer robustness:** 8/10 — no crash, no glitch on the 500-line payload, chip collapse is the right design. -2 for the layout-race that lets `Pasting text…` collide with the chip on first paint.
- **Composer ergonomics:** 7/10 — chip is great; byte/char count omission hurts; F2 stdin-as-typed behavior outside bracketed-paste hurts more.
- **YOLO safety on paste:** 4/10 — when bracketed-paste is missing, large stdin payloads execute as typed input with no confirmation. F2 is the highest-risk finding in this run.

## Notable surprises

- The TUI never tried to actually *render* the 29.6 KB markdown. The chip is opaque — no renderer was exercised on the malformed fences from the composer side at all. To genuinely stress the renderer the *agent* must echo the content back in an assistant message; that path was not exercised. Follow-up: feed malformed fences as agent output via a fixture, not as user paste.
- `Exfiltrating…` as a spinner verb directly after a user paste is a tone hazard worth flagging.
