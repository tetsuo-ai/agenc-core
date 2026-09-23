# Reported bugs

- `.` / `source` stdin-only heredocs classified as unknown commands with empty write targets — https://github.com/tetsuo-ai/agenc-core/pull/2053 — open — 2026-09-03
- `command`/`builtin`/`exec`/`env`/`eval` hid workspace writes from the shell write policy — https://github.com/tetsuo-ai/agenc-core/pull/2300 — open — 2026-09-08
- `setsid` / `ionice` / `watch` wrappers skipped the `rm -rf /` dangerous-command floor — https://github.com/tetsuo-ai/agenc-core/pull/2343 — open — 2026-09-09
- `dash` wrappers skipped the `rm -rf /` dangerous-command floor — https://github.com/tetsuo-ai/agenc-core/pull/2644 — open — 2026-09-22
- `ash` / `busybox` wrappers skipped the `rm -rf /` dangerous-command floor — https://github.com/tetsuo-ai/agenc-core/pull/2674 — open — 2026-09-23
