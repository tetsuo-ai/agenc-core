# Compact Service Parity

Source snapshot: `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/compact/apiMicrocompact.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/cachedMicrocompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/compactWarningHook.ts`
- `src/services/compact/compactWarningState.ts`
- `src/services/compact/grouping.ts`
- `src/services/compact/microCompact.ts`
- `src/services/compact/postCompactCleanup.ts`
- `src/services/compact/prompt.ts`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/compact/snipCompact.ts`
- `src/services/compact/timeBasedMCConfig.ts`

This directory owns AgenC's strict-compiled compact service surface:
- `compact.ts` builds manual compact summaries, post-compact history, command input tags, and conservative partial compact projections.
- `autoCompact.ts` owns threshold, warning, and automatic compact decisions.
- `microCompact.ts` clears older compactable tool results while preserving recent output.
- `cachedMicrocompact.ts` preserves the intentionally disabled cached micro-compact surface.
- `sessionMemoryCompact.ts`, `snipCompact.ts`, and cleanup/warning helpers expose strict-safe fallback behavior until their owning cross-cuts are completed.

Deliberately omitted cross-cuts:
- Cached micro-compact feature-flag branches remain disabled.
- Prompt-cache break detection and context collapse stay with their owning items.
- Transcript persistence and UI rendering stay outside the service boundary.
