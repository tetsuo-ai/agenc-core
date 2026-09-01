# Reported bugs

- Durable checkpoint prefix rejects writer `compactionHistory` (`RESPONSE_ITEM_KEYS`) — https://github.com/tetsuo-ai/agenc-core/pull/1960 — open — 2026-09-01
- `persistedMarketplaceSource` stored git userinfo (`https://token@host/repo.git`) and `plugin marketplace list` printed it — https://github.com/tetsuo-ai/agenc-core/pull/1982 — open — 2026-09-01
- Request-scoped editor caps / missing `EditorProposal` still yield `stopReason: "error"` and brick keep-alive sessions — https://github.com/tetsuo-ai/agenc-core/pull/1983 — open — 2026-09-01
- Editor withheld 413 / media_too_large / max_output_tokens recovery-blocked path yielded `stopReason: "error"` and latched keep-alive daemon runs — https://github.com/tetsuo-ai/agenc-core/pull/1988 — open — 2026-09-01
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
