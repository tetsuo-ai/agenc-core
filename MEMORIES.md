# Reported bugs

- apply_patch planning failures (unread file, missing path, allowlist) returned bare isError so the mutation gate blocked the session — https://github.com/tetsuo-ai/agenc-core/pull/2208 — open — 2026-09-06
- `.` / `source` stdin-only heredocs classified as unknown commands with empty write targets — https://github.com/tetsuo-ai/agenc-core/pull/2053 — open — 2026-09-03
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
