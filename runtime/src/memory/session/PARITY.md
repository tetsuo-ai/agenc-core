# Session Memory Parity

Upstream reference: TUI/source reference at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/SessionMemory/sessionMemoryUtils.ts`
- `src/services/SessionMemory/prompts.ts`

This directory owns the MM-04 session-memory subsystem:
- `sessionMemory.ts` owns post-sampling extraction, manual extraction, child-agent execution, and edit-only notes-file policy.
- `sessionMemoryUtils.ts` owns extraction thresholds, per-session state, path resolution, enablement gates, and read helpers.
- `prompts.ts` owns the default session notes template, custom prompt/template loading, variable substitution, prompt budget reminders, and compact truncation.

AgenC shape differences:
- Session memory is rooted under AgenC config home by project key and session id.
- Extraction runs through AgenC's live-agent runner and child tool policy rather than the donor hook registry.
- The old `runtime/src/services/SessionMemory/` path is intentionally removed; live callers import from `runtime/src/memory/session/`.
