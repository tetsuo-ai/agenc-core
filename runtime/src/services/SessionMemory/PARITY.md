# Session Memory Parity

Upstream reference: OC source checkout at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/SessionMemory/sessionMemoryUtils.ts`
- `src/services/SessionMemory/prompts.ts`

This directory owns the AgenC port of the session-notes maintainer:
- `sessionMemory.ts` runs the post-turn extraction queue and Edit-only subagent.
- `sessionMemoryUtils.ts` owns thresholds, extraction state, and notes-file paths.
- `prompts.ts` owns the default notes template, custom prompt loading, variable substitution, and compaction truncation helpers.
