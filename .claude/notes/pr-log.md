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

## PR #331: fix(runtime): finish unified session surface cleanup
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/channels/webchat/*`, `runtime/src/gateway/daemon-command-registry.ts`, `runtime/src/watch/*`, `runtime/tests/watch/*`, `runtime/src/browser.ts`, `web/src/components/chat/CommandResultPanel*`, `web/src/hooks/useChat*`, `web/test-server.mjs`
- **What worked:** Removing the last legacy protocol and command-name shims while adding structured runtime result payloads made shell, console, and web use the same command/session semantics instead of preserving transcript-only fallbacks, and the watch bootstrap hardening closed the session-auth loop that was breaking the TUI.
- **What didn't:** The final drift lived in several small places rather than one big subsystem, so landing the cleanup safely required coordinated protocol, watch, and web changes plus tighter test fixtures before the alias removals were trustworthy.
- **Rule added to CLAUDE.md:** no

## PR #332: fix(runtime): inject command registry into webchat
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/gateway/daemon.ts`
- **What worked:** The console/runtime error was a pure wiring bug: the daemon built the shared slash-command registry but never injected it into `WebChatChannel`, so a one-line dependency fix restored live `session.command.execute` handling immediately once the daemon was rebuilt and restarted.
- **What didn't:** The symptom initially looked like a stale-daemon issue because the old process was still running, but the new daemon log proved the failure persisted until the missing dependency injection was fixed.
- **Rule added to CLAUDE.md:** no

## PR #334: fix(watch): preserve session bootstrap control results
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/channels/webchat/operator-events.ts`, `runtime/src/channels/webchat/operator-events.test.ts`
- **What worked:** The remaining console bootstrap deadlock came from over-filtering session-scoped control responses; letting canonical `/session` command results bypass the active-session transcript filter preserved strict event scoping for normal traffic while allowing stale remembered sessions to recover cleanly.
- **What didn't:** The daemon was healthy and the command registry bug was already fixed, so the second failure looked like “console still broken” until the watch-side session filter was traced against the persisted watch-state bootstrap flow.
- **Rule added to CLAUDE.md:** no

## PR #335: fix(runtime): keep coding repairs productive within budget
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/llm/deterministic-acceptance-probes.ts`, `runtime/src/llm/completion-validators.ts`, `runtime/src/llm/turn-execution-contract.ts`, `runtime/src/llm/completion-validators.test.ts`, `runtime/src/llm/chat-executor-artifact-evidence.test.ts`
- **What worked:** Giving deterministic acceptance-probe recovery a bounded multi-attempt budget for workflow-owned coding turns let trivial compile/build failures self-heal through several repair turns, while the new “no successful workspace mutations since last probe” check stops the loop as soon as it stops making real progress.
- **What didn't:** The first full-executor regression accidentally used a `.txt` target, which this runtime classifies as documentation-only, and the short final success string also tripped the stop gate; the test had to be corrected before it was actually exercising the intended coding repair path.
- **Rule added to CLAUDE.md:** no
