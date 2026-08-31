# Reported bugs

- `sessionTranscriptV2FromRollout` / `messageTerminalFromEvent` treated mid-turn `error` (e.g. `stop_hook_threw`) as a turn closer — https://github.com/tetsuo-ai/agenc-core/pull/1937 — open — 2026-08-31
- Durable checkpoint writer/reader version skew (`editorToolCallsAdmitted` / `pendingAdmissionFallback`) discarded checkpoints on restart — https://github.com/tetsuo-ai/agenc-core/pull/1876 — open — 2026-08-31
- Gemini tool schemas with `$ref` failed preflight / used non-native JSON Schema fields — https://github.com/tetsuo-ai/agenc-core/pull/1872 — open — 2026-08-31
- Gateway cron `tick()` consumed one-shot tasks after `fireTask` throw or admission pause — https://github.com/tetsuo-ai/agenc-core/pull/1855 — rejected — 2026-08-31
