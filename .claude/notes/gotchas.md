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
