# Tips Service Parity

Upstream reference: OC source checkout at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/services/tips/tipScheduler.ts`
- `src/services/tips/tipRegistry.ts`
- `src/services/tips/tipHistory.ts`

This directory owns the AgenC port of the spinner-tip service:
- `tipHistory.ts` persists per-tip last-shown session counts in AgenC config home.
- `tipRegistry.ts` owns built-in and custom tip relevance plus cooldown filtering.
- `tipScheduler.ts` selects the longest-unseen relevant tip and records analytics when a tip is shown.
- `types.ts` defines the AgenC-owned context shape used instead of donor singletons.
