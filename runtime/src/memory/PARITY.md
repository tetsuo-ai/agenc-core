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
- project-instruction loader source
- `src/utils/memoryFileDetection.ts`
- `state/src/model/memories.rs`
- `state/src/runtime/memories.rs`
- `core-skills/src/render.rs`

This directory owns the MM-01 memory subsystem:
- `paths.ts` resolves the D-13 global, project, and compatibility memory paths.
- `memdir.ts` builds the typed memory prompt, entrypoint truncation, and explicit three-layer guidance.
- `types.ts`, `scan.ts`, `age.ts`, and `find-relevant.ts` provide memory taxonomy, scanning, freshness, and recall selection.
- `agencmd.ts` owns full AGENC.md discovery with includes and rules. It is the only temporary strictness boundary in this directory.
- `detection.ts` classifies memory files and memory-targeting shell patterns.
- `store.ts` ports the stage1/phase2 memory pipeline state facade onto AgenC's SQLite driver.

Pipeline activation:
- MM-01 owns the SQLite schema and `MemoryStore` lease/selection facade. The background producer/consumer loop that schedules stage1 extraction, runs phase2 consolidation, and injects consolidated output is intentionally left to later memory persistence/consolidation checklist items. Until then, runtime callers use the file-backed global and project durable memory paths directly.

Deferred boundary:
- `runtime/src/memdir/teamMemPaths.ts` and `runtime/src/memdir/teamMemPrompts.ts` remain outside this directory because team sync is skipped by the checklist. They import the owned memory primitives here.
