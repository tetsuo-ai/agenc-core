# Memory TUI Component Parity

Upstream reference: TUI/source reference at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/components/memory/MemoryFileSelector.tsx`
- `src/components/memory/MemoryUpdateNotification.tsx`
- `src/components/memory/memoryFileSelectorPaths.ts`

This directory owns the MM-06 TUI memory component port:
- `MemoryFileSelector.tsx` renders selectable user/project memory files, missing-file creation affordances, auto-memory folders, and feature-gated memory toggles.
- `MemoryUpdateNotification.tsx` renders the post-write notice and shortest display path helper.
- `selector-options.ts` keeps selector option construction and last-selection fallback testable without rendering the full TUI tree.
- `path-format.ts` owns path-aware HOME/cwd display shortening for update notices.

The selector path helper from `memoryFileSelectorPaths.ts` is intentionally not recreated here; MM-03 moved that logic into `runtime/src/memory/project-memory.ts` and both live component paths import that public API.
