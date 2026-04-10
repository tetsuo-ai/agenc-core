# Gotchas

## Runtime type drift clusters around shared union contracts
- When adding new members to `BackgroundRunWorkerPool` or new verifier issue codes, update every typed record/helper that keys on the union in the same change.
- The compiler will catch the misses, but the failures surface far from the original edit and are expensive to untangle after planner/verifier changes stack up.

## xAI OpenAI-compat endpoints can return `200` for undocumented fields
- Treat the xAI MCP/public docs as the only source of truth.
- Do not infer feature support from `HTTP 200` alone on `api.x.ai`.
- We have direct evidence that xAI can accept undocumented OpenAI-style fields and obvious fake fields with `200`, which makes `200` a weak signal for real support.
- Runtime rule: undocumented xAI fields must not be sent; fail closed instead of assuming silent support.

## Runtime dashboard assets must be built and synced with the runtime package
- `agenc ui` serves the runtime package's installed `dist/dashboard` assets, not the raw `agenc-core/web` source tree.
- Rebuilding `@tetsuo-ai/runtime` without also rebuilding/syncing the dashboard artifacts leaves the daemon healthy but makes `agenc ui` fail with "dashboard assets are unavailable".
- Keep dashboard asset generation in the runtime build path so ordinary runtime rebuilds cannot ship an empty dashboard surface.

## Top-level workflow completion depends on contract carryover, not just stop-gate prose checks
- If `resolveTurnExecutionContract()` collapses an implementation turn back to `dialogue`, top-level execution loses the verification/completion contract and the artifact-evidence gate never sees the target artifacts.
- Preserve workflow carryover from `activeTaskContext`, and make finalization derive completion/progress from the carried contract rather than passing `undefined` contracts through the request path.
- Without that plumbing, the model can stop on `finishReason: "stop"` and fabricate completion summaries even when only a subset of target files were actually written.

## Declarative agent definitions are inert until the sub-agent runtime can carry a per-child system prompt
- Loading `runtime/src/gateway/agent-definitions/*.md` into `Daemon._agentDefinitions` is not enough by itself; the child needs the markdown body wired into its own system prompt, not merely stuffed into the user task text.
- Without a per-child system prompt override, verifier workers fall back to the generic sub-agent prompt and the `verify.md` contract never actually governs the child turn.
