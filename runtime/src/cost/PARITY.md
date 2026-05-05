# Cost Runtime Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source path -->

Primary source anchors:
- `src/cost-tracker.ts`
- `src/costHook.ts`

This directory owns the donor-shaped cost runtime facade:
- `tracker.ts` exposes process-level cost getters, reset/restore helpers, and summary formatting by delegating to the active `CostSidecar`.
- `tracker.ts` also accepts live API/VCR token-dollar producers and API duration producers, then records them through the active `CostSidecar`.
- `hook.ts` preserves the cost-summary hook shape as a print-only fallback listener while bootstrap keeps live exit summary and persistence on `CostSidecar`.

Durable token, model, dollar, cache, and session-total accounting remains owned by `runtime/src/session/cost.ts`.
The retired mirror files under `runtime/src/agenc/upstream/` were deleted after the live callers moved to `runtime/src/cost/`; `scripts/goal/verify.mjs` now bans runtime imports of those retired `.js` paths across `runtime/src`.
