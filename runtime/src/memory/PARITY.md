# Memory Parity

Upstream references:
- TUI/source reference at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`
- Rust runtime reference at commit `fbdbc6b2fea7522e9fc1fc87d88168b945507ad4`

Primary source anchors:
- `src/memdir/memdir.ts`
- `src/memdir/memoryTypes.ts`
- `src/memdir/paths.ts`
- `src/memdir/memoryScan.ts`
- `src/memdir/memoryAge.ts`
- `src/memdir/findRelevantMemories.ts`
- `src/services/extractMemories/extractMemories.ts`
- `src/services/extractMemories/prompts.ts`
- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/SessionMemory/sessionMemoryUtils.ts`
- `src/services/SessionMemory/prompts.ts`
- project-instruction loader source
- `src/utils/memoryFileDetection.ts`
- `state/src/model/memories.rs`
- `state/src/runtime/memories.rs`
- `core-skills/src/render.rs`

This directory owns the MM-01 memory subsystem:
- `paths.ts` resolves the D-13 global, project, and compatibility memory paths.
- `privacy.ts` owns memory file scoping, memory-targeting command detection,
  and local secret screening before team-memory writes or uploads.
- `memdir.ts` builds the typed memory prompt, entrypoint truncation, and explicit three-layer guidance.
- `global-store.ts` composes the global memory path, prompt, scan, and manifest primitives into the user-level global store surface.
- `extraction-triggers.ts` owns model-visible ranges, main-agent/env gates, direct-write skip detection, and eligible-turn cadence for background memory extraction.
- `session/` owns session-scoped notes extraction, prompt generation, path resolution, and compact/read helpers.
- `types.ts`, `scan.ts`, `age.ts`, and `find-relevant.ts` provide memory taxonomy, scanning, freshness, and recall selection.
- `index.ts` exposes the public memory access surface consumed by tool and
  runtime code paths, including stable relevant-memory header formatting and
  branded instruction-memory loader, filtering, selector, cache-management,
  external-include, and @memory mention entrypoints.
- `agencmd.ts` owns full AGENC.md discovery with includes and rules. It is the only temporary strictness boundary in this directory.
- `project-memory.ts` is the strict project-memory API that consolidates the
  project-instruction loader, selector path, privacy helpers, and @memory
  mention syntax for callers.
- `store.ts` ports the stage1/phase2 memory pipeline state facade onto AgenC's SQLite driver.

Pipeline activation:
- MM-01 owns the SQLite schema and `MemoryStore` lease/selection facade. The background producer/consumer loop that schedules stage1 extraction, runs phase2 consolidation, and injects consolidated output is intentionally left to later memory persistence/consolidation checklist items. Until then, runtime callers use the file-backed global and project durable memory paths directly.

Deferred boundary:
- `runtime/src/memdir/memory-types.ts` is the PR-08 extraction-prompt
  taxonomy target. It is intentionally narrow; `memory/types.ts` remains the
  canonical recall and memory-prompt taxonomy surface.
- `runtime/src/memdir/teamMemPaths.ts` remains outside this directory because team sync is skipped by the checklist.
- `runtime/src/memdir/teamMemPrompts.ts` remains outside this directory, but its prompt text now imports the owned memory primitives here so TEAMMEM still preserves D-13 global/project/session guidance.
- `runtime/src/services/teamMemorySync/` remains the team sync transport
  boundary. It imports memory-owned privacy screening instead of owning scanner
  logic.
