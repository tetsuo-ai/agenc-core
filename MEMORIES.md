# Reported bugs

- `sessionTranscriptV2FromRollout` / `messageTerminalFromEvent` treated mid-turn `error` (e.g. `stop_hook_threw`) as a turn closer — https://github.com/tetsuo-ai/agenc-core/pull/1937 — open — 2026-08-31
- Durable checkpoint prefix hasher rejects writer `compactionHistory` after transactional compact — https://github.com/tetsuo-ai/agenc-core/pull/1960 — open — 2026-09-01
- Mid-turn/pre-sampling compact skip/throw emits run-fatal `error` and bricks keep-alive daemon sessions — https://github.com/tetsuo-ai/agenc-core/pull/1949 — open — 2026-08-31
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
- `updatePluginOp` / plugin CLI echoed raw `--source` userinfo and signed query values on successful update — https://github.com/tetsuo-ai/agenc-core/pull/1977 — open — 2026-09-01
