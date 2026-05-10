# Interrupter Persona — Round 2 (agenc 0.2.0 @ 4999c596)

## Environment
- Binary: `/home/tetsuo/.local/bin/agenc` (`agenc 0.2.0`)
- Driver: `script -q -c 'agenc --yolo'` with timed key streams
- Logs: `tests/ux/runs/interrupter-{keys,screen}.log`

## Findings

### 1) Ctrl-C during streaming — partial pass
Long-essay prompt sent (`/tmp/int1`), Ctrl-C fired 6s into stream. Footer
showed "esc to interrupt" hint (screen.log:2) and on Ctrl-C the runtime
rendered "Press Ctrl-C again to exit" (screen.log:2). The render shows the
streaming spinner cluster `✢*✶✻✽✻✶*✢` re-appeared AFTER the warning,
suggesting the model output kept flowing into the renderer until the
script's outer timeout (124). **Single Ctrl-C did NOT cancel streaming** —
only flipped the footer to the double-tap exit warning. No partial preserved
in transcript visible after warning.

### 2) Double Ctrl-C — works only on empty prompt
- Empty composer + `\x03\x03` (0.5s apart): exit=0, clean (screen.log:7-9).
- Mid-stream + `\x03 ... \x03`: the second Ctrl-C did NOT exit; the runtime
  kept the "Press Ctrl-C again to exit" hint visible and continued
  re-rendering (screen.log:5; outer timeout=124). The double-tap exit window
  appears to be cleared by intervening render activity. Bug: second Ctrl-C
  during active streaming is swallowed.

### 3) Ctrl-D — inconsistent
- Empty composer + single `\x04`: warns "Press Ctrl-D again to exit"
  (screen.log:11), exit=0 because no follow-up was sent.
- Empty + double `\x04`: clean exit=0, identical warning rendered.
- **Composer has text "hello there friend" + `\x04`**: no exit, no visible
  delete-char feedback, no warning. Outer timeout=124. Ctrl-D with a
  non-empty composer appears to be a no-op (neither delete-char-forward nor
  exit). Should at minimum delete one char or render a discoverable hint.

### 4) Ctrl-Z (suspend) — eaten silently
Composer "some test text" + `\x1a`: no suspend, no SIGTSTP forwarded, no
visible feedback, composer retained input (screen.log indicates only the
composer + no `[bg]` indicator). Outer timeout=124. Status: ignored. This
matches most agent TUIs (intentional), but there is also no visible
acknowledgement that the key was eaten.

### 5) Ctrl-L (redraw) — works
Composer "some text to keep" + `\x0c`: produced a redraw (screen.log
shows the prompt re-rendered with composer text intact, followed by a fresh
prompt frame). Transcript not lost; exit=0 after double Ctrl-C.

### 6) Ctrl-C during a tool call — does NOT cancel the tool
- Short tool (`find / -type f | head -10000`, ~6s): completed in full and
  the agent emitted an 81,656-token summary BEFORE Ctrl-C could be observed
  to do anything (screen.log:14). The Ctrl-C only landed after the tool
  returned. No mid-flight cancel.
- **Long tool (`sleep 60`)**: agent foregrounded as background session,
  then began `write_stdin` polling (screen.log:17). Triple Ctrl-C did NOT
  cancel the background session — the "Press Ctrl-C again to exit"
  warning kept being re-asserted (screen.log:17) but the polling loop
  continued. Outer timeout=124. This is a real bug: there is no
  user-accessible way to abort an in-flight tool call from the TUI.

### 7) Ctrl-C while typing — does not clear composer
Composer "some unsent text in composer" + `\x03`: produced "Press Ctrl-C
again to exit" (screen.log:8-style frame in int7) but **did not clear the
composer text** and did not show a "Press Ctrl-C to clear input" message
(which is the standard upstream-donor behaviour). Second Ctrl-C cleanly
exited (exit=0). Bug: first Ctrl-C should clear composer, not jump straight
to exit-warning.

### 8) Esc during streaming — the footer hint is a lie
Footer says "esc to interrupt" (screen.log:2,5,14,17,20). For an in-flight
500-word essay (`/tmp/int8`), `\x1b` (Esc) at 4s into stream did **nothing**.
The full essay completed to its concluding paragraph (screen.log:20). Esc
was silently dropped. This is the worst regression of the run because the
runtime is actively advertising a key binding that does not work.

## Tool-stop / zombie audit
- `ps auxww | grep -E "sleep 60|find / -type f"`: no leaked subprocesses.
- `agenc agent list` post-run: 3 new conv IDs (mp0735b3, mp073ad7, mp073d1i)
  appearing after 19:57:52 UTC — these match the timestamps of **other**
  personas spawning concurrently, not the interrupter runs. Pre-existing
  zombies from round 1 (mp06u7tv, mp06yi7x, mp06yvxw) still listed
  `running`. My runs did not register agents in the list (likely because
  `script -q` killed the daemon socket before persistence).

## Severity ranking
1. **HIGH**: Esc during streaming is advertised but non-functional
   (scenario 8). User expectation set by footer is violated.
2. **HIGH**: Ctrl-C cannot cancel an in-flight tool call (scenario 6b).
   No way for user to recover from a misbehaving long tool.
3. **MED**: Ctrl-C with non-empty composer skips clear-input step,
   goes straight to exit warning (scenario 7).
4. **MED**: Single Ctrl-C does not abort streaming; second Ctrl-C is
   absorbed by re-renders during streaming (scenarios 1, 2).
5. **LOW**: Ctrl-D with non-empty composer is a silent no-op
   (scenario 3c) — should delete-char or warn.
6. **LOW**: Ctrl-Z silently eaten with no acknowledgement (scenario 4).

## Pass list
- Ctrl-L redraw (scenario 5).
- Double Ctrl-C from empty prompt (scenario 2b).
- Ctrl-D double-tap from empty prompt (scenario 3b).
- No leaked background processes from interrupted tool calls.
