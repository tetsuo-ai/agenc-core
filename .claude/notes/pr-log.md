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

## PR #343: fix(runtime): only block on unresolved shell failures
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/llm/chat-executor-stop-gate.ts`, `runtime/src/llm/chat-executor-stop-gate.test.ts`
- **What worked:** Switching the bash-side stop-gate detector from “any failed shell call in the turn” to “latest unresolved shell failure” restored Claude-style stop-hook semantics, so honest recoveries no longer get blocked by stale failures that were already repaired later in the same turn.
- **What didn't:** The first stop-gate patch promoted turn-ledger history to a permanent blocker, which was stricter than Claude’s hook model and caused the runtime to stop on already-fixed failures until the detector was made resolution-aware.
- **Rule added to CLAUDE.md:** no
## PR #344: fix(runtime): default to builtin stop-hook finalization
- **Date:** 2026-04-13
- **Files changed:** `runtime/src/llm/hooks/stop-hooks.ts`, `runtime/src/llm/completion-validators.ts`, `runtime/src/llm/hooks/stop-hooks.test.ts`, `runtime/src/llm/completion-validators.test.ts`
- **What worked:** Making builtin stop hooks default-on aligned runtime behavior with the existing `stopHooksEnabled` contract and removed the validator-only fallback that was letting false completion leak through.
- **What didn't:** AgenC had drifted into a split contract where flags defaulted stop hooks on but the actual hook runtime only existed behind explicit config, which made the executor behave unlike Claude until this pass.
- **Rule added to CLAUDE.md:** no

## PR #346: fix(runtime): align edit retries and tool loops with claude
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/tools/system/filesystem.ts`, `runtime/src/tools/system/filesystem.test.ts`, `runtime/src/llm/chat-executor-tool-loop.ts`, `runtime/src/llm/chat-executor-tool-utils.ts`, `runtime/src/llm/chat-executor-constants.ts`, `runtime/src/llm/chat-executor-state.ts`, `runtime/src/llm/chat-executor-model-orchestration.ts`, `runtime/src/llm/chat-executor.ts`, `runtime/src/llm/chat-executor-types.ts`, `runtime/src/gateway/types.ts`, `runtime/src/gateway/config-watcher.ts`, `runtime/src/gateway/chat-executor-factory.ts`, `runtime/src/gateway/gateway.test.ts`, `runtime/src/llm/chat-executor-ctx-helpers.test.ts`
- **What worked:** Matching Claude’s stale-file contract made edit retries fail fast with an explicit reread requirement instead of grinding through repeated `old_string not found` misses, and removing the repeated-failure breaker let failing tool rounds continue under the normal hook and round budgets instead of a hidden three-strikes fuse.
- **What didn't:** AgenC still had dead breaker config, state, and tests after the stop path was removed, so the parity fix wasn’t complete until the dormant breaker surface was deleted as well.
- **Rule added to CLAUDE.md:** no

## PR #348: refactor(runtime): reduce loop and completion gate state
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/llm/chat-executor-tool-loop.ts`, `runtime/src/llm/hooks/stop-hooks.ts`, `runtime/src/runtime-contract/types.ts`, `runtime/src/gateway/top-level-verifier.ts`, `runtime/src/llm/completion-validators.ts`, `runtime/src/workflow/request-task-runtime.ts`, `runtime/src/tools/system/filesystem.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/llm/compact/*`
- **What worked:** Collapsing finalization onto the built-in stop-hook chain removed the second completion engine after hooks, while the file-tool cleanup and compaction attachment side-channel simplified the runtime around one message-centric loop with fewer hidden gates.
- **What didn't:** The refactor touched several dependent runtime surfaces at once, so type and test fallout showed up in hook typing and validator snapshot expectations before the reduced contract settled.
- **Rule added to CLAUDE.md:** no

## PR #349: refactor(runtime): reduce source-parity drift
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/tools/system/task-tracker.ts`, `runtime/src/llm/chat-executor-request.ts`, `runtime/src/llm/hooks/types.ts`, `runtime/src/llm/context-compaction.ts`, `runtime/src/tools/system/filesystem.ts`, `runtime/src/gateway/tool-handler-factory.ts`, `runtime/src/workflow/completion-state.ts`, `runtime/src/workflow/completion-progress.ts`, `runtime/src/runtime-contract/types.ts`
- **What worked:** Demoting normal-turn task and verifier gates, rebuilding compacted history with preserved messages, and rehydrating file read state removed the biggest runtime drifts from the source loop without regressing the explicit verification paths.
- **What didn't:** The broad reduction exposed lingering assumptions in progress snapshots and validator ordering, so several workflow and runtime-contract tests had to be updated after the code changes were already green in isolation.
- **Rule added to CLAUDE.md:** no

## PR #357: refactor(runtime): reduce source-parity drift in loop, compaction, and file state
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/llm/chat-executor-*`, `runtime/src/workflow/completion-{state,progress}.ts`, `runtime/src/gateway/{daemon,daemon-session-state,session,system-prompt-builder,tool-handler-factory}.ts`, `runtime/src/tools/system/filesystem.ts`, `containers/desktop/server/src/tools-editor.ts`
- **What worked:** Pulling the remaining milestone and verifier pressure out of the normal coding loop, persisting compacted sessions as rebuilt message streams, and enforcing one seeded read-state contract across runtime and desktop editor surfaces removed the largest remaining execution-model drifts without breaking the public result surface.
- **What didn't:** Session persistence and restore had hidden dependencies on artifact snapshot metadata and reduced replay history, so the refactor needed a dual-read migration path and broader daemon/session test coverage than the original loop-only reduction suggested.
- **Rule added to CLAUDE.md:** no

## PR #358: refactor(runtime): tighten long-session replay and loop finalization
- **Date:** 2026-04-14
- **Files changed:** `runtime/src/llm/chat-executor-{request,tool-loop,types}.ts`, `runtime/src/llm/{context-compaction,shell-write-policy}.ts`, `runtime/src/gateway/{session,daemon-session-state,daemon,tool-handler-factory}.ts`, `runtime/src/channels/webchat/plugin.ts`, `runtime/src/tools/system/{filesystem,bash,task-tracker}.ts`, `runtime/src/workflow/completion-state.ts`, `containers/desktop/server/src/{tools-editor,tools.test.ts}`
- **What worked:** Moving terminal ownership into the tool loop, persisting replay state as compact-boundary snapshots with hydrated artifact/read-state carryover, and requiring full-file read state before existing-file mutation closed the remaining long-session execution gaps without regressing the explicit verifier path.
- **What didn't:** Durable compaction still had hidden coupling between session metadata and artifact snapshot persistence, so the replay fix needed extra session/daemon integration coverage and exposed unrelated marketplace CLI and MCP typecheck drift during the broader repo validation run.
- **Rule added to CLAUDE.md:** no

## PR #374: refactor(runtime): align verifier ownership and task completion flow
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{system-prompt-builder,top-level-verifier}.ts`, `runtime/src/llm/{chat-executor-request,chat-executor-tool-loop,completion-validators}.ts`, `runtime/src/runtime-contract/types.ts`, `runtime/src/gateway/*.test.ts`, `runtime/src/llm/*.test.ts`, `.claude/notes/pr-log.md`
- **What worked:** Moving verifier ownership fully into the parent completion flow, removing task-progress from the completion gate, and hardening the verifier envelope write-root handling aligned the runtime with the intended execution model while keeping the delegated verifier contract explicit and test-covered.
- **What didn't:** The final cleanup exposed a build-only type hole in the verifier envelope path, so the branch needed one last guard before the source build and daemon restart were clean end to end.
- **Rule added to CLAUDE.md:** no

## PR #376: refactor(runtime): split public tasks from runtime handles
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/tools/system/task-tracker.ts`, `runtime/src/gateway/{daemon-command-registry,daemon-session-state,tool-handler-factory-coordinator,tool-handler-factory-delegation}.ts`, `runtime/src/runtime-contract/types.ts`, `runtime/src/gateway/*.test.ts`, `runtime/src/tools/system/task-tracker.test.ts`
- **What worked:** Splitting lightweight session tasks from runtime handles let the public `task.*` workflow return only session-task fields while delegated and coordinator flows moved to path-first background handles, which brought the runtime surface into one consistent model without losing durable runtime state internally.
- **What didn't:** The original task tracker and tests assumed one mixed surface, so separating the handle tools required a second factory plus coordinated fixture updates across delegation, coordinator, and daemon command tests before the suite settled.
- **Rule added to CLAUDE.md:** no

## PR #379: fix(runtime): align final reply acceptance and verifier root
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/top-level-verifier.ts`, `runtime/src/llm/{chat-executor-request,chat-executor-types}.ts`, `runtime/src/watch/{agenc-watch-event-store,agenc-watch-frame}.mjs`, `runtime/src/gateway/top-level-verifier.test.ts`, `runtime/src/llm/chat-executor-request.test.ts`
- **What worked:** Keeping streamed assistant text provisional until the accepted final reply arrives stops the cockpit from presenting rejected completion summaries as real answers, and threading the execution workspace root into the final result fixes verifier runs that were inspecting the wrong repo root.
- **What didn't:** The watch transcript had been conflating provider stream text with committed replies, so getting the behavior right required changing the presentation contract rather than adding another stop-hook patch.
- **Rule added to CLAUDE.md:** no

## PR #392: fix(runtime): unify file reads and unblock verifier retries
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/tools/system/filesystem.ts`, `runtime/src/tools/system/filesystem.test.ts`, `runtime/src/gateway/{system-prompt-builder,top-level-verifier,sub-agent}.ts`, `runtime/src/gateway/{top-level-verifier,sub-agent}.test.ts`
- **What worked:** Teaching the main file-read tool to handle targeted line windows on the same surface removed the repeated argument-shape failures, and giving verifier children an explicit unlimited round budget stopped retry verification from dying after a single tool call.
- **What didn't:** The original split between the main read tool and the range-only read tool had leaked into prompt guidance and test assumptions, so the fix needed prompt updates plus a narrower sub-agent budget override instead of a pure tool-schema change.
- **Rule added to CLAUDE.md:** no

## PR #394: fix(runtime): keep verifier children on the active workspace
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{top-level-verifier,sub-agent}.ts`, `runtime/src/gateway/{top-level-verifier,sub-agent}.test.ts`
- **What worked:** Making the child workspace root authoritative for both verifier artifact resolution and sub-agent runtime/tool routing stopped verifier runs from drifting back to the umbrella repo when the active session workspace was elsewhere.
- **What didn't:** The verifier had been trusting stale explicit contract artifacts even after the live runtime root changed, so the fix needed both artifact sanitization and child-session workspace propagation instead of a single cwd patch.
- **Rule added to CLAUDE.md:** no

## PR #397: refactor(runtime): align child cwd and verifier surfaces
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{delegation-tool,top-level-verifier,daemon-command-registry,daemon-tool-registry,tool-handler-factory-{delegation,coordinator}}.ts`, `runtime/src/utils/delegation-execution-context.ts`, `runtime/src/tools/system/task-tracker.ts`, `runtime/src/cli/{foundation,route-support}.ts`, `runtime/src/gateway/*.test.ts`, `runtime/src/tools/system/task-tracker.test.ts`
- **What worked:** Making child `cwd` a first-class public delegation field, persisting lightweight session tasks separately, and launching verifier children through the shared child-session contract eliminated the remaining surface mismatches without widening delegated filesystem authority.
- **What didn't:** The old verifier wrapper and stale task help text had assumptions baked into multiple tests, so the cleanup needed coordinated assertion changes across delegation, verifier, and task-store coverage before the runtime slice was fully green.
- **Rule added to CLAUDE.md:** no

## PR #398: fix(runtime): align child workspace launch flow
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{daemon-command-registry,daemon,delegation-runtime,tool-handler-factory,tool-handler-factory-delegation}.ts`, `runtime/src/tools/system/verification.ts`, `runtime/src/llm/chat-executor-tool-loop.ts`, `runtime/src/gateway/*.test.ts`, `runtime/src/tools/system/verification.test.ts`, `runtime/src/llm/chat-executor-artifact-evidence.test.ts`, `.claude/notes/pr-log.md`
- **What worked:** Threading the runtime workspace root all the way into delegated child launches and top-level verifier execution stopped child sessions from drifting back to the umbrella repo, while the richer shell-agent launcher path preserved the intended child scope and handle metadata.
- **What didn't:** The runtime already had most of the workspace plumbing, but one omitted handoff in the completion loop meant the verifier silently fell back to stale contract roots, so the failure only showed up at the very end of otherwise-correct runs.
- **Rule added to CLAUDE.md:** no

## PR #399: fix(runtime): keep multi-phase implementation runs durable
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{background-run-workflow-context,background-run-supervisor,background-run-supervisor-types,daemon,daemon-webchat-turn}.ts`, `runtime/src/workflow/completion-progress.ts`, `runtime/src/llm/{chat-executor-ctx-helpers,chat-executor-stop-gate}.ts`, `runtime/src/llm/hooks/stop-hooks.ts`, `runtime/src/gateway/*.test.ts`, `runtime/src/workflow/completion-progress.test.ts`, `runtime/src/llm/*.test.ts`
- **What worked:** Promoting explicit full-plan implementation requests into durable workflow execution, making request milestones authoritative for strict runs, and allowing milestone checkpoint summaries to continue instead of tripping narrated-future-work made long implementation sessions persist progress instead of dying after the first honest checkpoint.
- **What didn't:** The durable path needed wiring at multiple layers because request milestones were previously telemetry-only, background-run actor cycles were missing runtime evidence context, and stale verifier state could survive later mutations unless it was explicitly invalidated.
- **Rule added to CLAUDE.md:** no

## PR #400: fix(watch): separate final reply from transcript feed
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/watch/{agenc-watch-event-store,agenc-watch-frame}.mjs`, `runtime/tests/watch/{agenc-watch-event-store,agenc-watch-frame}.test.mjs`, `runtime/tests/watch/fixtures/agenc-watch-live-replay.fixture.mjs`
- **What worked:** Promoting the accepted agent reply to a canonical block while hiding ordinary agent rows from the scrolling transcript makes the cockpit read like a final answer plus supporting detail instead of a blended stream of provisional output and tool chatter.
- **What didn't:** The frame logic needed coordinated changes to transcript slicing, hidden-line markers, export behavior, and replay fixtures, so the UI adjustment touched more than just the renderer and needed full watch-suite coverage to prove it stayed stable.
- **Rule added to CLAUDE.md:** no

## PR #401: feat(runtime): persist interactive session context
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{interactive-context,session-summary-store,daemon-session-state,daemon-webchat-turn,daemon-text-channel-turn,session-transcript,session,sub-agent,top-level-verifier,daemon}.ts`, `runtime/src/channels/webchat/plugin.ts`, `runtime/src/llm/{chat-executor-init,chat-executor-types}.ts`, `runtime/src/gateway/{daemon-session-state,session-summary-store}.test.ts`, `runtime/src/gateway/{daemon-webchat-turn,daemon-text-channel-turn}.test.ts`, `runtime/src/llm/chat-executor-init.test.ts`
- **What worked:** Carrying interactive context as an explicit request payload, persisting it through replay and transcript metadata, and restoring read-state during hydration made resume and child/verifier launches reuse one consistent execution-location and prompt snapshot path.
- **What didn't:** The new path had to be threaded through session replay, transcript projection, executor init, and child launch points together, because any one missing handoff would have left resume state coherent in one surface and stale in another.
- **Rule added to CLAUDE.md:** no

## PR #404: fix(runtime): defer specialist tools and normalize model routing
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{daemon,daemon-webchat-turn,daemon-text-channel-turn,channel-wiring,daemon-command-registry,tool-routing,shell-profile,interactive-context,chat-usage,model-route}.ts`, `runtime/src/llm/{chat-executor-types,chat-executor-fallback,chat-executor-model-orchestration,chat-executor-request,chat-executor-tool-loop}.ts`, `runtime/src/llm/grok/{adapter,xai-strict-filter}.ts`, `runtime/src/watch/{agenc-watch-session-utils,agenc-watch-surface-dispatch}.mjs`, `runtime/src/gateway/{daemon,tool-routing}.test.ts`, `runtime/src/llm/grok/xai-strict-filter.test.ts`
- **What worked:** Moving non-default tools behind runtime-side discovery kept the default advertised bundle small while preserving later-turn access through persisted discovered tool state, and shared model-route normalization removed alias-only mismatch noise across runtime and watch surfaces.
- **What didn't:** The runtime had previously treated the callable tool universe and the advertised tool bundle as the same thing, so the fix needed coordinated daemon, executor, and watch updates before the provider-cap behavior and route display lined up cleanly.
- **Rule added to CLAUDE.md:** no

## PR #405: refactor(runtime): stabilize background continuation and verifier reuse
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{background-run-store,background-run-supervisor,background-run-supervisor-types,run-domains,sub-agent,top-level-verifier}.ts`, `runtime/src/llm/{chat-executor-tool-loop,chat-executor-types}.ts`, `runtime/src/llm/grok/adapter.ts`, `runtime/src/llm/provider-capabilities.ts`, and the matching runtime tests
- **What worked:** Persisting interactive continuation state for background runs, reusing verifier child sessions, keeping workspace runs from self-completing on weak evidence, and carrying child resume anchors across restarts removed the repeated verifier respawns and the long-run replay drift.
- **What didn't:** The continuation behavior was split across provider defaults, background-run state, child-session persistence, and verifier verdict parsing, so closing the gap required coordinated changes and test updates instead of a single runtime toggle.
- **Rule added to CLAUDE.md:** no

## PR #406: refactor(runtime): align compaction with current-view context
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/llm/compact/*`, `runtime/src/llm/chat-executor-{init,in-flight-compaction,history-compaction}.ts`, `runtime/src/gateway/{chat-usage,daemon,daemon-command-registry,llm-provider-manager,llm-stateful-defaults,session-summary-store}.ts`, `runtime/src/watch/agenc-watch-format-payloads.mjs`, and the matching runtime/watch tests
- **What worked:** Moving local compaction onto current-view effective-window accounting made the executor, `/context`, daemon status, and watch header all agree on the same pressure signal, and the targeted executor test updates kept the runtime behavior verified against the new threshold model instead of the old cumulative-budget assumptions.
- **What didn't:** A few compaction tests were still asserting cumulative token spend and an older per-iteration threshold shape, so the parity pass needed both runtime code changes and fixture recalibration before the suite reflected the intended behavior.
- **Rule added to CLAUDE.md:** no

## PR #407: fix(runtime): keep background and child tool bundles scoped
- **Date:** 2026-04-15
- **Files changed:** `runtime/src/gateway/{background-run-supervisor,background-run-supervisor-types,daemon,sub-agent}.ts`, `runtime/src/gateway/{background-run-supervisor,sub-agent}.test.ts`
- **What worked:** Passing the resolved advertised tool bundle into background actor cycles and child-session launches kept both paths on the same scoped tool surface as foreground turns, which prevents provider-side trimming from broad fallback catalogs.
- **What didn't:** Background and child execution had each kept their own fallback path to the executor-wide allowlist, so fixing the live overflow required patching both call sites and adding dedicated regressions instead of relying on the earlier foreground-only routing work.
- **Rule added to CLAUDE.md:** no
