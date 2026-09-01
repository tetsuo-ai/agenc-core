# Reported bugs

- `persistedMarketplaceSource` stored git userinfo (`https://token@host/repo.git`) and `plugin marketplace list` printed it — https://github.com/tetsuo-ai/agenc-core/pull/1982 — open — 2026-09-01
- Live daemon bridge latched `agent.status=error` on mid-turn telemetry (`stream_disconnected` / `stop_hook_threw`) — https://github.com/tetsuo-ai/agenc-core/pull/1978 — open — 2026-09-01
- Agent tools `close_agent`/`assign_task`/`send_message` pre-mutation refusals lacked `confirmed_no_effect` and poisoned the session — https://github.com/tetsuo-ai/agenc-core/pull/1976 — open — 2026-09-01
- Checkpoint prefix `RESPONSE_ITEM_KEYS` rejected writer-emitted `compactionHistory` — https://github.com/tetsuo-ai/agenc-core/pull/1960 — open — 2026-09-01
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
