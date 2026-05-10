# Phase 0: Build + smoke

## Repo HEAD
6ace5164 merge fix/donor-purge-runtime-stubs

## Build
- Source: runtime/, tsup-bundled to runtime/dist/
- Command: cd runtime && npm run build
- Exit: 0
- Warnings in tests/ux/build.log: 2 (informational, see file)
- Bundle artifacts verified by check-package-entrypoints

## Smoke launch
- Daemon: `agenc daemon restart` → clean
- Binary: /home/tetsuo/.local/bin/agenc (version 0.2.0)
- Launcher: shell wrapper that execs node runtime/dist/bin/agenc.js
- One-shot: `agenc --no-tui "say 'smoke ok' and stop"` → returned "smoke ok"

## Launch commands subagents should use
- Interactive TUI: `agenc` (default mode) or `agenc --yolo` (skip permissions in trusted projects)
- One-shot: `agenc --no-tui "<prompt>"`
- Resume: `agenc --resume <session-id>` or `agenc -c` (continue latest)
- Driving the TUI under a pty: `script -q -c 'agenc' /tmp/tui.log` works on this host (util-linux 2.39.3). node-pty is NOT available on this host; use `script` or shell here-strings.
- Daemon-side state: agents listed via `agenc agent list`; logs via `agenc agent logs <id>`
- For interactive scripted input use a here-string or expect-style timing: `(sleep N; printf 'keys'; sleep M; printf '\x03') | timeout T script -q -c 'agenc' /tmp/log`

## Trust dialog
First-time use in any directory shows a trust dialog. Subagents should drive a `cd <dir>` first, then expect a "Trust this project?" prompt with "Yes, I trust this project" / "No, exit". Selecting Yes persists in `~/.agenc/trusted-projects.json`.

## Known broken/removed donor surfaces (do NOT report as bugs)
The runtime just had a large purge of donor backend code that pointed at api.anthropic.com. The following surfaces are intentionally dead in this build:
- /login, /logout (slash commands removed)
- /remote-control, /bridge-kick (removed)
- /ultrareview, /ultraplan (removed)
- /extra-usage, /pr-comments (moved-to-plugin stubs)
- Grove privacy dialog (never mounted; backend gone)
- Teleport (any cross-machine session resume)
- Settings sync, voice STT, team memory sync, remote-managed settings
- BridgeDialog, RateLimitMessage, BackgroundTasksDialog (component stubs return null)
- Subscription/billing flows (referral, overage credits, ultrareview quota)

These are NOT in scope. If a subagent's path through the TUI lands on one of these, that should be noted as "feature unavailable" — not "bug".
