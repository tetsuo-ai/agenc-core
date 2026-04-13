## PR #159: fix(runtime): harden artifact update routing and verification
- **Date:** 2026-04-05
- **Files changed:** `runtime/src/llm/*`, `runtime/src/workflow/*`, `runtime/src/gateway/delegation-*`, `runtime/src/utils/delegation-execution-context.ts`
- **What worked:** Replacing heuristic artifact/workflow escalation with a direct-owner artifact contract fixed the route class, stale verification inheritance, conditional no-op semantics, and explicit `@artifact` normalization in one coherent runtime path.
- **What didn't:** Artifact-intent classifier precedence and workspace-grounding phrase detection were still too narrow at first, which let explicit `@PLAN.md` repair requests drift into grounded-plan-generation or artifact-only review until the classifier and grounding detector were tightened.
- **Rule added to CLAUDE.md:** no

## PR #327: fix(web): stop stuck thinking after completed turn
- **Date:** 2026-04-12
- **Files changed:** `web/src/hooks/useChat.ts`, `web/src/hooks/useChat.test.ts`
- **What worked:** Moving typing-state ownership back to the top-level chat lifecycle fixed the stuck-thinking race without disturbing delegated timeline rendering, and the regression tests cover both late subagent traffic and terminal `chat.response`.
- **What didn't:** The UI hook had quietly treated subagent lifecycle events as a second source of truth for run completion, which made the bug look like a runtime/executor issue until the webchat state path was traced end to end.
- **Rule added to CLAUDE.md:** no

## PR #330: feat(runtime): unify shell, console, and web session surfaces
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/channels/webchat/*`, `runtime/src/gateway/*`, `runtime/src/watch/*`, `runtime/src/cli/*`, `runtime/src/browser.ts`, `web/src/components/chat/*`, `web/src/hooks/useChat*`, `runtime/README.md`, `packages/agenc/README.md`
- **What worked:** Treating the daemon command registry and shared session continuity/cockpit contracts as the product source of truth let the shell, console, and web clients converge without inventing a second orchestration layer, while the watch cleanup removed duplicated first-party command paths instead of leaving compatibility logic to drift.
- **What didn't:** The older watch and web clients each had their own local command assumptions, so finishing the parity pass required tightening protocol shapes and structured result metadata before the UI layers could stop depending on ad hoc transcript-oriented behavior.
- **Rule added to CLAUDE.md:** no
