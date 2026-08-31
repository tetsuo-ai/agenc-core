# Reported bugs

- `streamModel` admission step id reused on continuation-nudge / mid-turn compact continue (`turnCount` + `recoveryReentryCount` unchanged) — https://github.com/tetsuo-ai/agenc-core/pull/1847 — open — 2026-08-31
- `invokeCompactionProvider` omitted `tools`, so admitted summaries inherited the session factory catalog and denied `context_window_exceeded` — https://github.com/tetsuo-ai/agenc-core/pull/1851 — open — 2026-08-31
