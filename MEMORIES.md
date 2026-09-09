# Reported bugs

- `.` / `source` stdin-only heredocs classified as unknown commands with empty write targets — https://github.com/tetsuo-ai/agenc-core/pull/2053 — open — 2026-09-03
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
- `setsid` / `ionice` / `watch` wrappers skipped the `rm -rf /` dangerous-command floor — https://github.com/tetsuo-ai/agenc-core/pull/2343 — open — 2026-09-09
