# T-16 Cost Usage Parity

## Scope

T-16 owns the cost and usage TUI cells under `runtime/src/tui/cost/`.

## Absorbed Files

- `Stats.tsx`
- `TokenWarning.tsx`
- `MemoryUsageIndicator.tsx`
- `tokenAnalytics.ts`

## Live Wiring

- `runtime/src/tui/components/PromptInput/Notifications.tsx` renders `TokenWarning` and `MemoryUsageIndicator` from `runtime/src/tui/cost/`.
- `Stats.tsx` is staged in the same cost cluster for slash-screen wiring that depends on the absorbed stats UI.
- `tokenAnalytics.ts` is co-located with the cost cluster and covered by focused tests.

## Verification

- `tokenAnalytics.test.ts` covers recording, aggregation, cache-rate reporting, model frequency, max-entry retention, and clearing history.
- `scripts/goal/verify.mjs T-16` checks deleted upstream files and retired import paths.
