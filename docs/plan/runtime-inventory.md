# AgenC runtime Inventory

Every AgenC runtime file AgenC hand-ports from Rust to TypeScript. Rust source is
**reference in hand** — LLM-assisted translation is fast when the source
is visible. See [`translation-conventions.md`](translation-conventions.md)
for Rust→TS mapping rules.

**Totals (corrected):** ~12,000 LOC of Rust hand-ported to ~14,000 LOC
of TS across session, tools, agents, client, protocol, rollout. Earlier
"~4,000 LOC" estimate only counted the spine and omitted `mod.rs`,
`handlers.rs`, the full tools subsystem, agent control plane, and full
`client.rs`. Accurate per-file LOC in the tables below.

**Load-bearing escalation since multi-provider decision:**
`client.rs` (1,978 LOC) is now a **full port**, not a cherry-pick.
See [`provider-matrix.md`](provider-matrix.md) for why — AgenC runtime's
multi-provider dispatch is the target architecture.

---

## 1. Session kernel (Tranche 4b)

**Source:** `/home/tetsuo/git/AgenC runtime/AgenC runtime-rs/core/src/session/`

| File | Rust LOC | Purpose | TS Destination | Priority |
|---|---|---|---|---|
| `session.rs` | 852 | `Session` struct; event channels; state mutation lock | `runtime/src/session/session.ts` | P0 |
| `turn.rs` | 2,230 | `run_turn()` — phase orchestration | `runtime/src/session/run-turn.ts` | P0 |
| `turn_context.rs` | 626 | Per-turn config snapshot; model metadata | `runtime/src/session/turn-context.ts` | P0 |
| `mod.rs` | 3,042 | Session lifecycle; history; mailbox; tool routing (see §1a breakdown) | Split across 5 TS files | P0 |
| `agent_task_lifecycle.rs` | 182 | Task registration; caching; identity match | `runtime/src/agents/task-lifecycle.ts` | P1 |
| `rollout_reconstruction.rs` | 304 | Event log replay; history rebuild after rollback/compaction | `runtime/src/session/rollout-reconstruction.ts` | P1 |
| `handlers.rs` | 1,232 | Dispatch for realtime, shell, review, interrupt | Partial port — fold into phases | P2 |
| `mcp.rs` | 291 | MCP elicitation request/response | Fold into existing `mcp-client/` | P2 |
| `review.rs` | 164 | Guardian review session manager | Skip — AgenC runtime-specific | — |

### `mod.rs` breakdown (3,042 LOC — §1a)

`mod.rs` is AgenC runtime's session umbrella. It's not monolithic — splits
cleanly into five responsibilities. AgenC ports to five TS files,
not one.

| Rust lines (approx) | Responsibility | TS destination |
|---|---|---|
| ~1–400 | Public API + re-exports + session builder | `runtime/src/session/index.ts` (barrel) |
| ~400–1,100 | Session lifecycle — init, fork, resume, shutdown, drop | `runtime/src/session/lifecycle.ts` |
| ~1,100–1,800 | History mutation — append, replace, rollback, compaction boundary | `runtime/src/session/history.ts` |
| ~1,800–2,400 | Mailbox + inter-agent routing (ties to I-5 bidirectional mailbox) | `runtime/src/agents/mailbox.ts` + `runtime/src/session/inter-agent.ts` |
| ~2,400–3,042 | Tool routing + approval cache wiring | `runtime/src/session/tool-routing.ts` |

Each split ships with its own test file. The 3,042-LOC-in-one-file
Rust idiom is not preserved; TS readability demands the split.

---

### Session struct (`session.rs`)

| Field | Rust type | TS equivalent |
|---|---|---|
| `conversation_id` | `ThreadId` | `string` |
| `tx_event` | `Sender<Event>` | `EventEmitter \| AsyncQueue<Event>` |
| `agent_status` | `watch::Sender<AgentStatus>` | `BehaviorSubject<AgentStatus>` (or EventEmitter with replay) |
| `state` | `Mutex<SessionState>` | `AsyncLock<SessionState>` |
| `managed_network_proxy_refresh_lock` | `Mutex<()>` | `Semaphore(1)` |
| `active_turn` | `Mutex<Option<ActiveTurn>>` | `AsyncLock<ActiveTurn \| null>` |
| `mailbox` | `Mailbox` | `Mailbox<InterAgentCommunication>` (see §3) |
| `mailbox_rx` | `Mutex<MailboxReceiver>` | `AsyncLock` wrapping `AsyncQueue` |
| `services` | `SessionServices` | DI container `{ modelClient, hooksManager, … }` |
| `js_repl` | `Arc<JsReplHandle>` | Singleton service ref |
| `out_of_band_elicitation_paused` | `watch::Sender<bool>` | `BehaviorSubject<boolean>` |

### `run_turn` phases (from `turn.rs`)

| # | Phase | Lines | Inputs | Mutates |
|---|---|---|---|---|
| 0 | Pre-sampling compaction | 148–157 | `auto_compact_limit` | conversation history |
| 1 | Context update + skill injection | 161–358 | turn input, skill outcomes, plugins | history, mailbox |
| 2 | User-prompt hooks | 288–314 | raw input | history, pending_input queue |
| 3 | **Main loop: sampling request** | 382–662 | conversation history | see sub-phases |
| 3a | Pending input inspection | 390–427 | mailbox state | history if accepted |
| 3b | Build sampling request | 437–458 | `history.for_prompt()` | read-only |
| 3c | Sample from model | 452–508 | `client_session` | tool calls + agent msg |
| 3d | Tool execution + loop | inside `run_sampling_request` | tool calls | history, state |
| 3e | Auto-compact (mid-turn) | 493–508 | token count | history replacement |
| 4 | Stop hook | 513–567 | last agent msg | history if hook prompts |
| 5 | After-agent hooks | 568–625 | sampling output | side effects only |

**Port strategy:** keep AgenC runtime ownership of the live session/turn kernel and
merge in AgenC's retained phase behavior where called for. AgenC
already supplies phase 3 (streaming) and 3d (tool execution) behavior well;
AgenC runtime remains the owner of the `Session` struct, `TurnContext` snapshot, and
phase orchestration discipline.

### TurnContext (`turn_context.rs`)

Immutable per-turn snapshot. Every phase function reads it; nothing writes to it after creation.

| Field | Type | Purpose |
|---|---|---|
| `sub_id` | string | Turn ID for telemetry + event routing |
| `model_info` | `ModelInfo` | Context window, modality, `auto_compact_limit` |
| `config` | `Arc<Config>` | Frozen session settings (sandbox, approvals, shells) |
| `auth_manager` | `Option<Arc<AuthManager>>` | ChatGPT auth gating |
| `provider` | `SharedModelProvider` | LLM client factory |
| `cwd` | `AbsolutePathBuf` | Session-scoped working directory |
| `turn_skills` | `TurnSkillsContext` | Skill injection outcome |
| `approval_policy` | `Constrained<AskForApproval>` | Exec gate policy |
| `shell_environment_policy` | `ShellEnvironmentPolicy` | Shell exec sandbox |

**TS shape:** `class TurnContext { readonly subId: string; readonly modelInfo: ModelInfo; readonly config: Readonly<SessionConfig>; ... }` — all `readonly`, construct once, pass through.

### Rollout reconstruction (`rollout_reconstruction.rs`)

Pure reverse-scan → forward-replay algorithm.

1. **Reverse scan** (newest → oldest): find latest `CompactedItem` with `replacement_history`; collect metadata:
   - `previous_turn_settings` (model, realtime_active) from newest surviving user turn
   - `reference_context_item` (turn baseline) from newest user turn or compaction-clear
   - Rollback tracking: count + skip rolled-back user turns
2. **Forward replay** (oldest → newest) of the suffix after latest replacement checkpoint:
   - Record `ResponseItem`s into history
   - Apply `ThreadRolledBack` by dropping last N user turns
   - Handle `Compacted`: use `replacement_history` if present, else fallback rebuild
   - Ignore `EventMsg` (metadata only)

Result: `{ history, previousTurnSettings, referenceContextItem }`.

**Tool call handling:** all tool calls remain in history as `ResponseItem`s; compaction summarizes context but does not elide tool calls.

---

## 2. Tools + concurrency (Tranche 6)

**Source:** `/home/tetsuo/git/AgenC runtime/AgenC runtime-rs/core/src/tools/`

| File | Rust LOC | Purpose | TS Destination | Priority |
|---|---|---|---|---|
| `parallel.rs` | 194 | `ToolCallRuntime` + `RwLock` read/write gating | `runtime/src/tools/concurrency.ts` | P0 |
| `router.rs` | 306 | `ToolRouter` — dispatch to handlers; check parallel flags | `runtime/src/tools/router.ts` | P1 |
| `orchestrator.rs` | 447 | Approval → sandbox → attempt → retry flow | `runtime/src/tools/orchestrator.ts` | P1 |
| `context.rs` | 584 | `ToolPayload` enum; `ToolOutput` trait | `runtime/src/tools/context.ts` | P1 |
| `registry.rs` | 665 | Tool spec registry; handler registration | Fold into existing `tool-registry.ts` | P2 |
| `events.rs` | 528 | Tool event tracing; telemetry payloads | Partial port | P2 |
| `network_approval.rs` | 688 | Network approval: blocking, deferred, policy rules | `runtime/src/permissions/network-approval.ts` | P2 |
| `sandboxing.rs` | 386 | Approval store; `ApprovalCtx`; `ExecApprovalRequirement` | `runtime/src/permissions/sandbox.ts` | P2 |
| `spec.rs` | 337 | Tool spec; code-mode augmentation | Partial port | P2 |
| `handlers/`, `runtimes/`, `code_mode/`, `js_repl/` | 14,484 total | MCP/shell/apply_patch handlers; shell adapters; JS REPL | Skip — AgenC uses its own tool implementations |

### Concurrency gating (the load-bearing bit)

**Rust (parallel.rs:28–140):**

```rust
pub struct ToolCallRuntime {
    router: Arc<ToolRouter>,
    parallel_execution: Arc<RwLock<()>>,
}

// line 115–119
let _guard = if supports_parallel {
    Either::Left(lock.read().await)     // concurrent
} else {
    Either::Right(lock.write().await)   // serial
};
```

**Parallel-support source (router.rs:142–169):**
- Function tools: `ConfiguredToolSpec.supports_parallel_tool_calls` flag
- MCP tools: per-server allowlist in `parallel_mcp_server_names: HashSet`
- Custom payloads: always serial

**TS port:**

```ts
enum ConcurrencyClass {
  Exclusive,             // serial writer
  SharedRead,            // concurrent readers
  SharedServer,          // concurrent per serverId
  BackgroundTerminal,    // long-running, off-ladder
}

class ToolCallRuntime {
  private sharedLock = new AsyncRwLock();

  async handleToolCall(call: ToolCall): Promise<Result> {
    const klass = this.router.classify(call);
    if (klass === ConcurrencyClass.Exclusive) {
      return this.sharedLock.withWrite(() => this.dispatch(call));
    }
    return this.sharedLock.withRead(() => this.dispatch(call));
  }
}
```

**Synergy with AgenC's `StreamingToolExecutor`:** AgenC uses a per-tool `isConcurrencySafe` check; AgenC runtime uses an `RwLock`. Combine: AgenC's streaming ring buffer with AgenC runtime's explicit enum-driven concurrency class. `isConcurrencySafe` maps 1:1 to `ConcurrencyClass.SharedRead`; non-safe tools map to `Exclusive`.

### Sandbox (skip Rust primitives, port the approval decision model)

Rust sandbox uses Seatbelt/Landlock/seccomp — **do not port.** Port only the decision enums:

```ts
enum ApprovalPolicy { Never, OnFailure, OnRequest, Granular, Untrusted }
enum SandboxMode { DangerFullAccess, ReadOnly, WorkspaceWrite, ExternalSandbox }
enum ExecApprovalRequirement {
  Skip(bypass_sandbox: boolean),
  Forbidden(reason: string),
  NeedsApproval(reason: string | null),
}
enum ReviewDecision {
  Approved,
  ApprovedForSession,
  ApprovedExecpolicyAmendment,
  NetworkPolicyAmendment,
  Denied,
  Abort,
  TimedOut,
}
```

### Tool metadata schema

```ts
// Ported from ConfiguredToolSpec + ToolSpec enum
interface ConfiguredToolSpec {
  spec: ToolSpec;
  supportsParallelToolCalls: boolean;
}

type ToolSpec =
  | { kind: 'function', fn: FunctionToolSpec }
  | { kind: 'freeform', fn: FreeformToolSpec }
  | { kind: 'namespace', fn: NamespaceToolSpec }
  | { kind: 'tool_search' }
  | { kind: 'local_shell' }
  | { kind: 'web_search' };

interface ApprovalCtx {
  session: Session;
  turn: TurnContext;
  callId: string;
  guardianReviewId?: string;
  retryReason?: string;
  networkApprovalContext?: NetworkApprovalContext;
}
```

---

## 3. Agents + mailbox (Tranche 9)

**Source:** `/home/tetsuo/git/AgenC runtime/AgenC runtime-rs/core/src/agent/`

| File | Rust LOC | Purpose | TS Destination | Priority |
|---|---|---|---|---|
| `mailbox.rs` | 161 | Typed inter-agent message queue (mpsc + watch) | `runtime/src/agents/mailbox.ts` | P0 |
| `control.rs` | 1,214 | Main control-plane: spawn/resume/interrupt, lifecycle | `runtime/src/agents/control.ts` | P0 |
| `registry.rs` | 344 | In-memory registry; spawn slots; path→thread | `runtime/src/agents/registry.ts` | P1 |
| `role.rs` | 434 | Role layer + config application; built-in roles | `runtime/src/agents/role.ts` | P1 |
| `status.rs` | 27 | `AgentStatus` FSM from events | `runtime/src/agents/status.ts` | P1 |
| `agent_resolver.rs` | 36 | Resolves agent targets by name/path/id | Skip — simple | — |
| `mod.rs` | 14 | Module exports | — | — |

Final ownership note: in the replacement target, AgenC runtime ports under
`agents/{control,mailbox,registry,role,status}.ts` plus child `session/*`
own subagent lifecycle. AgenC-owned `delegate.ts` and `run-agent.ts`
remain adapters/behavior ports only.

### Mailbox shape

**Rust:**
- Sender: unbounded `mpsc` + `watch` sequence channel
- Receiver: `mpsc` rx + `VecDeque` buffer
- `send()` → returns monotonic `u64` seq immediately (unbounded)
- Ops: `has_pending()`, `has_pending_trigger_turn()`, `drain()`
- Message: `InterAgentCommunication { author, recipient, content, trigger_turn }`

**TS port:**

```ts
interface InterAgentCommunication {
  author: AgentPath;
  recipient: AgentPath;
  content: string;
  triggerTurn: boolean;
  seq: number;
}

class Mailbox {
  private queue: InterAgentCommunication[] = [];
  private seqCounter = 0;
  private seqWatch = new BehaviorSubject<number>(0);

  send(msg: Omit<InterAgentCommunication, 'seq'>): number {
    const seq = ++this.seqCounter;
    this.queue.push({ ...msg, seq });
    this.seqWatch.next(seq);
    return seq;
  }

  hasPending(): boolean { return this.queue.length > 0; }
  hasPendingTriggerTurn(): boolean { return this.queue.some(m => m.triggerTurn); }
  drain(): InterAgentCommunication[] { return this.queue.splice(0); }
}

class MailboxReceiver {
  async *watch(): AsyncIterable<InterAgentCommunication> {
    // Subscribe to seqWatch; yield new messages as they arrive
  }
}
```

Multi-producer, single-consumer. `Weak<MailboxReceiver>` per agent in Rust → in TS we keep an explicit registry.

### Role spec (`role.rs`)

```ts
interface AgentRoleConfig {
  description?: string;
  configFile?: string;        // embedded .toml (awaiter.toml, explorer.toml)
  nicknameCandidates?: string[];
}

interface AgentMetadata {
  agentId?: ThreadId;
  agentPath?: AgentPath;      // "/root/explorer/foo" hierarchical
  agentNickname?: string;
  agentRole?: string;         // role name
  lastTaskMessage?: string;
}
```

### Built-in agents (port all three as defaults)

| Name | Role | Config | Purpose |
|---|---|---|---|
| `default` | default | none | Unrestricted agent |
| `explorer` | explorer | explorer.toml (empty) | Codebase queries, fast, authoritative |
| `awaiter` | awaiter | awaiter.toml | Long-running polling (3600s timeout, low reasoning) |

### Lifecycle (`control.rs`)

1. **Spawn:** `spawn_agent()` → `spawn_agent_internal()` → allocate slots (max_threads check), fork or new thread, emit `SpawnReservation`
2. **Fork mode:** fork parent's rollout, filter to user + final messages, spawn child with `FullHistory` or `LastNTurns`
3. **Resume:** `resume_agent_from_rollout()` → recursive queue for descendants, reconstruct tree from persisted spawn edges
4. **Interrupt:** `interrupt_agent()` → `Op::Interrupt` to thread
5. **Shutdown:** `shutdown_live_agent()` → `Op::Shutdown`, cascade to descendants, release slot, remove from registry
6. **Close:** mark spawn edge `Closed` in state_db, then shutdown tree
7. **Status:** `subscribe_status()` → `watch::Receiver<AgentStatus>`. Final states: `Completed`, `Errored`, `Shutdown`, `Interrupted`

---

## 4. Protocol + event log (Tranche 5)

**Source:** `/home/tetsuo/git/AgenC runtime/AgenC runtime-rs/protocol/src/protocol.rs` (5,266 LOC — we take only event/rollout types, ~500 LOC effective)

### EventMsg variants (78 total; we keep 16 — see below)

AgenC runtime has 78 event variants. Most are AgenC runtime-specific (realtime voice, guardian review, collab agents, plan mode, skills). AgenC needs a minimal discriminated union covering: turn lifecycle, content, tool lifecycle, approval gates, compaction, errors.

**Proposed minimal AgenC EventLogEntry (~18 variants, ~400 LOC of TS):**

```ts
type EventLogEntry =
  | { type: 'session_meta'; meta: SessionMetaLine }
  | { type: 'turn_started'; event: TurnStartedEvent }
  | { type: 'turn_context'; context: TurnContextItem }
  | { type: 'agent_message'; message: AgentMessageEvent }
  | { type: 'user_message'; message: UserMessageEvent }
  | { type: 'token_count'; count: TokenCountEvent }
  | { type: 'mcp_tool_call_begin'; event: McpToolCallBeginEvent }
  | { type: 'mcp_tool_call_end'; event: McpToolCallEndEvent }
  | { type: 'exec_command_begin'; event: ExecCommandBeginEvent }
  | { type: 'exec_command_end'; event: ExecCommandEndEvent }
  | { type: 'exec_approval_request'; request: ExecApprovalRequestEvent }
  | { type: 'request_permissions'; request: RequestPermissionsEvent }
  | { type: 'context_compacted'; event: ContextCompactedEvent }
  | { type: 'turn_complete'; event: TurnCompleteEvent }
  | { type: 'turn_aborted'; event: TurnAbortedEvent }
  | { type: 'thread_rolled_back'; event: ThreadRolledBackEvent }
  | { type: 'error'; error: ErrorEvent }
  | { type: 'stream_error'; error: StreamErrorEvent };
```

### Skip

- Realtime voice (`RealtimeConversation*` — 5 variants)
- Guardian review (`ApplyPatchApprovalRequest`, `GuardianAssessment`)
- Collaboration (`CollabAgent*` — 12 variants)
- Plan mode (`PlanUpdate`, `PlanDelta`)
- Reasoning delta streaming (take `AgentReasoning` full only; skip delta variants)
- Image generation (`ImageGenerationBegin/End`, `ViewImageToolCall`)
- Hook events (we have our own hook model already)
- MCP startup events (handled at session start in AgenC)
- `ItemStarted/Completed`, `RawResponseItem`, `ModelReroute` — AgenC runtime-specific routing

### RolloutItem wrapper (6 variants — port all)

```ts
type RolloutItem =
  | { type: 'session_meta'; payload: SessionMetaLine }
  | { type: 'session_state'; payload: SessionStateUpdate }
  | { type: 'response_item'; payload: ResponseItem }
  | { type: 'compacted'; payload: CompactedItem }
  | { type: 'turn_context'; payload: TurnContextItem }
  | { type: 'event_msg'; payload: EventLogEntry };
```

### Serialization

- JSONL; one `RolloutItem` per line
- Serde JSON with `{ "type": "snake_case", ...payload }` discriminant
- Legacy aliases: `task_started`/`task_complete` accepted for `TurnStarted`/`TurnComplete`
- Versioning: single `cli_version: string` in `SessionMetaLine`; no formal schema version

**TS destination:** `runtime/src/session/event-log.ts`, `rollout-item.ts`, `event-log-reducer.ts`.

---

## 5. Model client — full port (multi-provider dispatch)

**Source:** `/home/tetsuo/git/AgenC runtime/AgenC runtime-rs/core/src/client.rs` (1,978 LOC)

**Previously:** "cherry-pick only, AgenC has Grok adapter." **Now:**
full port. With multi-provider in scope (see
[`provider-matrix.md`](provider-matrix.md)), AgenC runtime's two-level client
design is the target architecture. AgenC's current Grok adapter
becomes one of N implementations behind it.

### Two-level structure to port

- **Session-scoped `ModelClient`** (Arc'd) — holds conversation id,
  auth provider, install id, transport fallback flags, response
  cache.
- **Turn-scoped `ModelClientSession`** — wraps per-turn state:
  sticky routing token, connection pool, last response id.

### Feature port priorities

| Feature | AgenC runtime lines | AgenC status | Port? |
|---|---|---|---|
| Two-level client struct (Session + Turn) | 1–240 | Missing | **Yes** — core architecture |
| Multi-provider dispatch | 60–199 | Missing | **Yes** — `provider.is_openai()`, `provider.is_azure_responses_endpoint()`, `supports_websockets` |
| Unified auth resolution | 362–438 | Missing | **Yes** — `current_client_setup()` pattern routes OAuth vs bearer |
| Auth refresh + retry loop | 1154–1211, 1699–1961 | Missing | **Yes** — OAuth providers only (ChatGPT, future); inert for bearer-key providers |
| `previous_response_id` incremental reuse | 909–946 | Missing | **Yes** — per-provider via capability flag (see invariant I-2 for clear-on-compact) |
| Capability-flagged request shaping | 437–443, 620–637, 833–852 | Missing | **Yes** — maps 1:1 to `llm/capabilities.ts` registry |
| Sticky routing (`x-AgenC runtime-turn-state`) | 215–226, 973–984 | Missing | OpenAI only (AgenC runtime-specific header); gate behind capability flag |
| Prompt cache keying via conversation id | 853, 870 | Partial (Grok adapter has it) | **Yes** — centralize in `llm/shape-request.ts` |
| Telemetry: wire_api, transport, timing | 1119–1130, 1216–1227 | Partial | **Yes** — uniform per-provider trace output |
| Session-scoped WebSocket pooling | 212–240, 361–373 | Missing | Skip — AgenC is in-process, Grok/OpenAI use HTTPS |
| Transport fallback flag (atomic) | 188–189, 1479–1489 | Missing | Skip — same reason |
| WebSocket prewarm | 1272–1274 | Missing | Skip — same reason |
| Request compression (Zstd) | 1103–1111 | Missing | Defer — test if providers accept |
| Multi-endpoint abstraction (`/responses`, `/compact`, `/memories`) | various | Partial | Partial — AgenC uses only `/responses` and `/chat/completions` endpoints today |

### AgenC destination

```
runtime/src/llm/
  provider.ts               # createProvider() factory (existing stub — expand)
  types.ts                  # LLMProvider interface (keep, exists at :578)
  capabilities.ts           # NEW — static capability registry per (provider, model)
  shape-request.ts          # NEW — capability-driven request composer
  wire/
    responses-xai.ts        # NEW — xAI /v1/responses shape
    responses-openai.ts     # NEW — OpenAI /v1/responses shape
    messages-anthropic.ts   # NEW — Anthropic /v1/messages shape
    chat-completions.ts     # NEW — OpenAI Chat Completions (covers OpenAI legacy, Ollama, LMStudio, OpenRouter, Groq, DeepSeek, Gemini beta)
  oauth/
    refresh-loop.ts         # NEW — shared OAuth helper (AgenC runtime auth-refresh port)
  providers/
    grok/                   # RELOCATED from runtime/src/llm/grok/ — unchanged internals
    openai/                 # NEW
    anthropic/              # NEW
    ollama/                 # existing — keep
    lmstudio/               # NEW
    openrouter/             # NEW
    groq/                   # NEW
    deepseek/               # NEW
    gemini/                 # NEW
```

**Grok adapter stays working throughout.** Provider abstraction lands
in T5 with a single-provider (Grok) path. New adapters land in T13
one at a time, each gated behind a feature flag + explicit
capability registry entry.

---

## 6. Sandboxing + approval (Tranche 11)

**Source:** `core/src/tools/sandboxing.rs` + `core/src/tools/network_approval.rs` + `execpolicy/`

**Port only the decision model** — Rust OS primitives do not translate.

### Approval policy enum

| Value | Behavior |
|---|---|
| `never` | Never ask user; failures returned to model |
| `on_failure` | Auto-approve most; escalate only on sandbox failure |
| `on_request` | Model decides when to request approval (default) |
| `granular` | Fine-grained per-category (sandbox_approval, rules, skill_approval, request_permissions) |
| `untrusted` | Always ask unless FS unrestricted; auto-approve only known-safe read-only |

### Sandbox policy enum

| Mode | Restrictions |
|---|---|
| `danger-full-access` | No restrictions |
| `read-only` | Read-only disk; optional network flag |
| `workspace-write` | Read-only + write to cwd + `writable_roots` |
| `external-sandbox` | Process is in external sandbox; full disk + network setting |

### Approval cache

- Schema: `HashMap<String, ReviewDecision>` keyed on serialized JSON of approval subject
- Lifetime: session-scoped, in-memory, cleared at end
- Multi-key: for tools like `apply_patch`, each key cached individually; `ApprovedForSession` only if all keys hit

### Network approval

- Trigger: network request hits allowlist miss + approval policy permits review
- Scope cache: by host + protocol + port
- Grant scope: `AllowOnce | AllowForSession | Deny`
- Dialog: target (e.g., `https://example.com:443`); optional policy amendment

### execpolicy DSL

Prefix-pattern rule engine, not code:

```
allow    <program> <arg1> <arg2> ...
prompt   <program> <arg1> ...
forbidden <program> ...
```

Separate rule set for network rules (host/protocol/port).

Decisions: `Allow` (no prompt), `Prompt` (ask unless policy=never), `Forbidden` (reject).

### OS primitives → TS alternatives (AgenC skip; reference only)

| OS primitive | AgenC runtime function | TS alternative |
|---|---|---|
| Seatbelt (macOS) | sandbox-exec + SBPL | Worktree + permission evaluator + env jail |
| Landlock (Linux) | eBPF access control | Worktree + permission evaluator |
| seccomp (Linux) | Syscall whitelist (bubblewrap) | Env jail |
| Bubblewrap | Namespace isolation | Worktree (separate dir) + PATH override |
| Windows Sandbox | Sandboxed process + Private Desktop | Worktree + env jail |

**AgenC destination:** `runtime/src/permissions/{approval-policy,sandbox-policy,approval-cache,network-approval,rules}.ts`.

---

## 7. Config + prompts (Tranche 10)

**Source:** `AgenC runtime-rs/config/src/config_toml.rs` + `AgenC runtime-rs/core/config.schema.json` + `AgenC runtime-rs/core/src/prompts/`

### Config file

- Path: `~/.AgenC runtime/config.toml`
- Format: TOML + JSON Schema validation
- AgenC picks: `~/.agenc/config.toml` or `~/.agenc/config.json` — **user preference** (AgenC uses `.json` in `settings.json`). Suggest TOML to match AgenC runtime + better for nested config.

### Schema (fields worth porting)

- `model`, `model_provider`, `model_context_window`
- `approval_policy`, `approvals_reviewer`, `sandbox_mode`
- `default_permissions`, `permissions` (named profiles)
- `instructions`, `developer_instructions`, `model_instructions_file`, `compact_prompt`
- `mcp_servers` (HashMap), `mcp_oauth_credentials_store`
- `model_reasoning_effort`, `plan_mode_reasoning_effort`, `model_reasoning_summary`
- `profile` (active name), `profiles` (named dict)
- `projects` (per-project trust levels), `project_root_markers`, `project_doc_max_bytes`, `project_doc_fallback_filenames`
- `features` (feature flag table)
- `history`, `sqlite_home`, `log_dir`
- `agents` (thread limits, job runtime, role configs)

### Profiles

`ConfigProfile` struct — named configs that override top-level keys:
- Can override: `model`, `service_tier`, `model_provider`, `approval_policy`, `sandbox_mode`, `reasoning_effort`, `personality`, `web_search`, `tools`
- Activated via top-level `profile: "name"`
- Profile-scoped `features` sub-table supported

### System prompt storage

Embedded via Rust `include_str!`:
- Base: `prompts/base_instructions/default.md` (~80 lines)
- Approval policy variants: `prompts/permissions/approval_policy/{never,unless_trusted,on_failure,on_request,…}.md`
- Sandbox mode variants: `prompts/permissions/sandbox_mode/{read_only,workspace_write,danger_full_access}.md`

Override: `model_instructions_file` — absolute path to custom instructions.
Developer instructions injected separately via `developer_instructions`.

### AGENTS.md hierarchy (AgenC runtime matches AgenC closely)

1. Walk CWD → root; default root marker `.git`; configurable via `project_root_markers`
2. Collect `AGENTS.md` + fallback filenames from root → CWD (inclusive)
3. Concatenate in order; max size via `project_doc_max_bytes`
4. Inject into user instructions with separator `"--- project-doc ---"`
5. Local override: `AGENTS.override.md` checked before `AGENTS.md`

### Env vars

- `AGENC_HOME` / `AGENC_SQLITE_HOME` → AgenC `AGENC_HOME`
- `AGENC_CA_CERTIFICATE` → custom CA bundle
- `AGENC_THREAD_ID` → thread identifier (injected by harness)

**AgenC action:** adopt TOML config with the AgenC `settings.json` schema as the base; add AgenC runtime profile layer + AGENTS.md ancestor walk. Already designed for this — see `behavior-inventory.md §8`.

**AgenC destination:** `runtime/src/config/{loader,schema,profiles,agents-md,env}.ts`.

---

## 8. Rollout + replay (Tranche 5 + 7)

**Source:** `AgenC runtime-rs/rollout/src/` (7,357 total) + `core/src/session/rollout_reconstruction.rs` (304)

### On-disk layout (AgenC runtime)

```
~/.AgenC runtime/sessions/
  rollout-{timestamp}-{thread_id}.jsonl
```

AgenC mirrors with per-project scoping:

```
~/.agenc/projects/<slug>/sessions/
  rollout-{timestamp}-{session_id}.jsonl
```

### Reconstruction algorithm

See §1 "Rollout reconstruction" above — pure reverse-scan → forward-replay.

### Snapshot + index

No explicit snapshots. Compaction serves as implicit snapshot: `CompactedItem { message, replacement_history }` holds the full reconstructed history up to the compaction point.

Index: reverse-scan from file tail to first `CompactedItem` with `replacement_history`; skip older items entirely. O(n) worst-case, O(1) typical.

### Reconnection flow

1. CLI detects missing session or stale connection
2. Calls `Session::initialize_with_history(InitialHistory::Resumed(ResumedHistory { history, rollout_path }))`
3. Reconstruction replays rollout → rebuilds `SessionState` (history, settings, baseline context)
4. Session resumes at next user input (no auto-continue of incomplete turns)

### Schema evolution

- No explicit versioning in `RolloutItem`; enums are open for new variants (old readers skip unknown)
- Optional fields via `#[serde(default, skip_serializing_if = "Option::is_none")]`
- Legacy compaction fallback (`saw_legacy_compaction_without_replacement_history`)
- `cli_version` stored in `SessionMeta` for debugging version skew

**AgenC destination:** `runtime/src/session/{rollout-store,rollout-reconstruction,snapshot}.ts`.

---

## 9. CLI + TUI + slash commands (reference only)

**Source:** `AgenC runtime-rs/cli/` + `AgenC runtime-rs/tui/` + `AgenC runtime-rs/tui/src/chatwidget/slash_dispatch.rs`

**Decision:** AgenC TUI is Ink/React from AgenC, not ratatui.
AgenC runtime's slash dispatch and status line are reference material for
design, not port targets.

### Cherry-pick candidates

| Concept | AgenC runtime file | AgenC destination | Why |
|---|---|---|---|
| Status-line configurability | `bottom_pane/status_line_setup.rs` (64KB) | `runtime/src/tui/cockpit/StatusLineConfig.ts` | Users toggle/reorder 12+ metrics (model, tokens, context %, git, limits) |
| Inline slash command args | `slash_dispatch.rs` | `runtime/src/commands/dispatcher.ts` | `/review <path>`, `/plan <args>`, `/side <prompt>` — easier UX than modal popups |
| ASCII animation scheduler | `chatwidget/ascii_animation.rs` | `runtime/src/tui/hooks/useAnimationTick.ts` | Decouples animation tick from render loop |
| Exec cell model | `exec_cell/model.rs` | `runtime/src/tui/transcript/ExecCell.tsx` | Maps task IDs, tracks exit codes, live output |
| Approval overlay UX | `bottom_pane/approval_overlay.rs` (56KB) | `runtime/src/tui/permissions/ApprovalOverlay.tsx` | Multi-choice approval with inline context |
| Collaboration-mode masking | `collaboration_modes::plan_mask()` | `runtime/src/permissions/mode-mask.ts` | Switch model behavior via runtime config mask |

### AgenC runtime slash commands (reference list — AgenC picks subset)

From `slash_dispatch.rs` enum `SlashCommand` (strum derive, 59 variants):

`/model`, `/fast`, `/approvals`, `/permissions`, `/status`, `/plan`, `/review`, `/side`, `/rename`, `/resume`, `/fork`, `/init`, `/compact`, `/clear`, `/diff`, `/copy`, `/mcp`, `/settings`, `/ps`, `/stop`, `/clean`, and ~38 more.

AgenC merges with AgenC's 46+ commands (see `behavior-inventory.md §7`). Reconcile naming where they differ.

---

## 10. Missed-features sweep (AgenC runtime)

Features outside the main subsystems worth porting or at least learning from.

### Must-take

| Feature | Path | Rust LOC | Rationale |
|---|---|---|---|
| Stop hooks + completion detection | `hooks/src/events/stop.rs` | 547 | Direct replacement for missing AgenC stop detection; mid-turn model override + hook-driven continuation |
| Stream parsing (thinking/plan blocks) | `utils/stream-parser/src/` | 500+ | Citation extraction, proposed_plan stripping, inline hidden tags. Handles block-based model output |
| MCP client manager | `AgenC runtime-mcp/src/mcp_connection_manager.rs` | 1,870 | Tool discovery, dependency resolution, connection lifecycle, tool naming, auth, reconnect. Direct improvement over AgenC's MCP |
| Rollout + replay | `rollout/src/` | 7,357 | Already captured in §8 |

### Nice-to-have

| Feature | Path | Rust LOC |
|---|---|---|
| Compaction (local + remote) | `core/src/compact.rs` + `compact_remote.rs` | 933 |
| Hook event system | `hooks/src/` | 1,681 |
| OTEL metrics + telemetry | `otel/src/` | 2,109 |
| Test harnesses (snapshot + fixtures) | `core/tests/common/context_snapshot.rs` | 602 |
| Error taxonomy | `protocol/src/error.rs` | 631 |
| Git integration (ghost commits) | `git-utils/src/ghost_commits.rs` | 1,786 |
| Streaming controller (TUI) | `tui/src/streaming/controller.rs` | 401 |
| Output truncation | `utils/output-truncation/src/` | 617 |
| PTY abstraction | `utils/pty/src/` | 1,238 |
| Cloud tasks (daemon) | `cloud-tasks/src/` | 4,801 |

### Skip

Cache util, keyring-store, process-hardening (Linux-specific).

### Crate organization pattern (adopt)

AgenC runtime structure:
- `utils/*` — feature-focused utility crates
- `core/`, `otel/`, `hooks/`, `protocol/` — domain crates
- `chatgpt/`, `lmstudio/` — client adapters

AgenC mirror in `runtime/src/`:
- `utils/` — shared helpers
- `session/`, `phases/`, `tools/`, `permissions/`, `agents/`, `recovery/`, `transport/`, `tui/`, `commands/`, `prompts/` — domain modules
- `llm/providers/{grok,openai,anthropic}/` — adapters
