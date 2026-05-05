# Conversation Manager Parity

Upstream reference: `/home/tetsuo/git/codex` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`. <!-- branding-scan: allow upstream source root -->

Primary source anchors:

- `codex-rs/core/src/thread_manager.rs` <!-- branding-scan: allow upstream path -->
- `codex-rs/core/src/codex_thread.rs` <!-- branding-scan: allow upstream path -->
- `codex-rs/core/src/thread_rollout_truncation.rs` <!-- branding-scan: allow upstream path -->
- `codex-rs/core/src/session_startup_prewarm.rs` <!-- branding-scan: allow upstream path -->
- `codex-rs/core/src/session/rollout_reconstruction.rs` <!-- branding-scan: allow upstream path -->

This directory owns the TypeScript conversation/thread manager surface for
RT-01:

- `thread-manager.ts` composes the existing AgenC thread manager, rollout
  reconstruction, and bootstrap-prewarm seams into a conversation-owned manager.
- `thread-manager.contract.test.ts` covers root registration, replay into
  session state, synthesized recovery events, operation routing, and prewarm
  status tracking.

Startup prewarm contract:

- `ConversationThreadManager` always pre-builds a default turn context and
  prewarms agent-task registration.
- Providers that expose `LLMProvider.prewarmStartup()` are invoked during
  startup prewarm with the active conversation/thread IDs. When they return a
  provider handle, the first regular model-stream request consumes that handle
  before falling back to the normal provider path.
- The production Grok provider implements that hook by warming its client and
  model-list path, then handing the first stream through the warmed provider
  instance. Provider adapters without a native startup/session prewarm hook are
  skipped.

## ZC-29 breadth audit

Decision: no additional file split is needed for the audited conversation surface. The donor spreads
thread lifecycle, per-thread operations, rollout truncation, startup prewarm, and rollout
reconstruction across several Rust modules. AgenC's public conversation boundary is the
`ConversationThreadManager`; the existing file folds those behaviors into one manager because
lower-level thread execution, durable state, provider access, and app-server protocol handling are
already owned by neighboring AgenC subsystems.

Carried behavior:
- root and child thread registration over the shared `ThreadManager`
- replay of restored rollout items into live session state
- forked child threads from truncated rollout history
- serialized fork/root turn execution through per-session locks
- synthesized recovery events for orphaned rollout turns
- startup prewarm and provider-handle consumption semantics

Intentional reductions:
- The donor's full process-backed thread spawner, environment manager, auth manager, model manager,
  MCP manager, and thread-store construction remain in AgenC's session, agents, auth, app-server,
  LLM, state, and MCP modules rather than being duplicated under `runtime/src/conversation/`.
- Out-of-band elicitation counters and remote thread-store plumbing are not added here because
  AgenC's protocol and daemon surfaces already own those user-visible contracts.

## ZC-35 Coverage Lock

Source anchor: `/home/tetsuo/git/openclaude` at commit
`0ca43335375beec6e58711b797d5b0c4bb5019b8`,
`src/utils/conversationRecovery.ts`.

Decision: TypeScript transcript-resume recovery is carried through AgenC's
rollout-backed thread recovery and bootstrap path, with source-shape reductions
documented here instead of adding a second transcript loader.

Carried behavior:
- rollout-backed resume into live session state
- root and child thread registration during bootstrap
- initial resume-history recording with prior token and tool state
- synthesized recovery events for orphaned rollout turns
- `SessionStart` resume-source propagation through configured lifecycle hooks

Intentional reductions:
- arbitrary transcript-file resume, legacy attachment migration, and
  skill-state restoration are not duplicated because AgenC resumes from indexed
  rollout/state stores.
- interrupted-prompt auto-continue sentinels are not carried into bootstrap;
  turn recovery is owned by state replay and tool recovery categories.
- the donor transcript-size cap is not copied because AgenC reconstructs resume
  state from indexed rollout items rather than a single pre-REPL message
  payload.
