# Phase 0: Build + smoke (round 2)

## Repo HEAD
4999c596 merge fix/ux-issues — UX persona-test fixes

Round 2 runs against the same HEAD that landed round-1 UX fixes.
Round 1's outputs are preserved under `tests/ux/round-1/` for comparison.

## Build
- Source: `runtime/`, tsup-bundled to `runtime/dist/`
- Command: `cd runtime && npm run build`
- Exit: 0
- Warnings in `tests/ux/build.log`: 2 informational TS6133 unused-variable warnings

## Smoke launch
- Daemon: `agenc daemon restart` → clean (new pid 220923)
- Binary: `/home/tetsuo/.local/bin/agenc` (version 0.2.0)
- One-shot: `agenc --no-tui "say 'round-2 smoke ok' and stop"` → returned `round-2 smoke ok`

## Launch commands subagents should use
- Interactive TUI: `agenc` or `agenc --yolo`
- One-shot: `agenc --no-tui "<prompt>"`
- Driving under a pty: `script -q -c 'agenc' /tmp/tui.log` (util-linux 2.39.3). `node-pty` is NOT available.
- Scripted input: `(sleep N; printf 'keys'; sleep M; printf '\x03') | timeout T script -q -c 'agenc' /tmp/log`
- Special keys: `\x03`=Ctrl-C, `\x04`=Ctrl-D, `\x0c`=Ctrl-L, `\x12`=Ctrl-R, `\x09`=Tab, `\x1b`=Esc, `\r`=Enter, Up=`\x1b[A`, Down=`\x1b[B`
- ANSI strip: `sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g'`

## Intentionally-dead surfaces (do NOT report as bugs)
- `/login`, `/logout`, `/remote-control`, `/bridge-kick`, `/ultrareview` — deleted in donor purge
- `/extra-usage`, `/pr-comments` — moved-to-plugin placeholders
- Grove privacy dialog, Teleport, settings sync, voice STT, team memory, remote-managed settings, billing — gone
- BridgeDialog, RateLimitMessage, BackgroundTasksDialog — stub to null

## Round-1 fixes that should hold (regressions if any persona sees these)
- No "Found N keybinding errors" banner on cold launch
- `/help` renders the real command list, not "registry pending"
- `/status`, `/usage`, `/effort`, `/model` render panels with no `unsafePeek` crash
- `/context` shows a friendly "requires the in-process runtime" message, not the raw JS error
- `/history` does not silently run `/clear`
- Submitted prompts persist to `~/.agenc/history.jsonl`
