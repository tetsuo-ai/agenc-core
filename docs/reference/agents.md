# Multi-agent & background agents

AgenC runs concurrent agent work on two related surfaces:

1. **Multi-agent v2 tools** — model-facing tools the main (or coordinator)
   agent uses to spawn and steer workers inside a live turn loop.
2. **Background agents** — daemon-owned long-lived agents
   (`agent.create` / SDK `spawnAgent`) that own a session and can be attached
   from TUI, CLI, SDK, or the channel gateway.

## Multi-agent v2 tool surface

Implementation: `runtime/src/agents/v2/`. Parity notes:
[`runtime/src/agents/v2/PARITY.md`](../../runtime/src/agents/v2/PARITY.md).

Registered by `createMultiAgentV2Tools()` (plus CSV job tools from the same
LIVE multi-agent surface):

| Tool | Role |
| --- | --- |
| `spawn_agent` | Spawn a reusable worker and its initial bounded task |
| `wait_agent` | Wait for, then drain, all delivered mailbox updates |
| `close_agent` | Terminally close a worker and its descendants |
| `assign_task` | Admit one new task to an idle reusable worker (**triggers a turn**) |
| `send_message` | Queue passive context (**does not** trigger a turn) |
| `list_agents` | Read the live agent tree and current statuses |
| `spawn_agents_on_csv` | Fan out workers from CSV rows (job orchestrator) |
| `report_agent_job_result` | Report a CSV/job worker result back to the orchestrator |

### Worker lifecycle

The reusable worker and each accepted task are separate lifecycles:

| Worker status | Meaning | Can accept `assign_task`? |
| --- | --- | --- |
| `pending_init` | Spawn is not ready to run | No |
| `running` | A task turn is active | No |
| `idle` | The prior keep-alive turn ended and the worker is waiting | Yes, if no assignment is outstanding |
| `interrupted` | A turn was interrupted; non-final for watcher semantics | No |
| `completed` | Terminal completion used by one-shot/compatibility paths | No |
| `errored` | Irreversible error | No |
| `shutdown` | Terminally closed | No |
| `not_found` | Lookup did not resolve a live worker | No |

The normal successful v2 path is
`pending_init → running → idle → running … → shutdown`. Every task gets a
fresh model-turn/run context, timeout controller, `turn_id`, and per-turn tool
count; a tool-using task may make multiple provider calls. The originating
`task_id` is the spawn/assignment call correlation ID.

### Assignment admission and passive messages

`assign_task` accepts only when all of these are true:

- sender and target differ;
- the sender is a strict ancestor of the target agent path;
- the target is not the root;
- the target is a live `idle` reusable worker;
- the target has no outstanding accepted assignment.

The runtime checks those conditions, allocates `task_id` + `turn_id`, marks the
assignment outstanding, and enqueues the trigger atomically. A rejected
assignment enqueues nothing. A successful tool response reports acceptance and
the two IDs; completion arrives later as a correlated receipt.

`send_message` shares strict non-empty `target` and `message` validation but is
passive. It neither allocates a task nor starts a provider turn. Authenticated
peer context is held within mailbox bounds and folded into the next admitted
assignment; non-ancestor peer prose is framed as untrusted data.
`assign_task` and `send_message` both reject content above 65,536 UTF-8 bytes
(and enforce the same character ceiling).

The worker always drains a triggering assignment before another provider call.
This prevents a wake notification from replaying stale input.

### Task outcomes and mailbox delivery

Before notifying the parent, the worker durably records
`subagent_turn_outcome` in its child journal. The child record is the
authoritative task outcome. A successfully delivered parent
`<subagent_notification>` reports:

- runtime agent identity/path, role, and role-workspace provenance;
- `lifecycle: "turn"`, `task_id`, `turn_id`, and per-turn tool-call count;
- one outcome: `completed`, `errored`, `interrupted`, or `nack`;
- final message or reason, when present;
- post-turn worktree evidence for isolated workers.

`nack` means the assignment was accepted but teardown occurred before it
started (`worker_teardown_before_start`), and its outcome is committed and
offered for parent projection before child-session shutdown. The journal
append precedes parent mailbox projection; on durable-append failure, AgenC
clears the outstanding admission, marks the worker `errored`, warns, and does
not present the result as durable. Correlated receipts suppress the older
generic completion notification for the same turn.

Parent projection is bounded and live-process scoped. Projected prose and
worktree strings are truncated, while `projection_id` and the durable child
outcome reference remain available for correlation. The in-memory outbox
retries transient send/backpressure failures while the parent process remains
live. It is not a cross-journal exactly-once protocol: a process loss between
child commit and mailbox delivery may require recovery from the child rollout,
and any future replay must deduplicate by `projection_id`. If the live outbox
saturates, the durable outcome remains valid, but AgenC warns and marks the
worker lifecycle `errored`; it does not claim that the parent received the
receipt or leave the worker silently reusable.

The root session mailbox retains at most 512 records / 16 MiB. Human idle
input and triggering receipts are protected and can displace passive chatter,
which produces visible sequence-aware omission summaries. A protected
record—or a batch of steered human input—is rejected atomically when no safe
capacity exists. TUI/daemon staging buffers accept at most 512 non-empty
inputs and 16 MiB of measured serialized retained content blocks. Model-bound
human batches receive opaque, submission-scoped admission tokens: a failure
before the turn consumes them removes only that exact batch and restores the
composer instead of leaking stale attachments or skill expansion into a later
prompt; consumed or indeterminate outcomes are not duplicated. Per model
turn, agent projection is capped at 32 records / 128 KiB. Oversized first
records are visibly truncated for forward progress; only deferred triggers
schedule autonomous follow-up turns, while passive context waits for the next
human/root turn.

`wait_agent` drains all currently delivered updates, not one named worker. It
is therefore mutating and intentionally has no target filter. Use
`list_agents` for a non-mutating status view, and call `wait_agent` only when
the next critical-path step needs a pending result.

All v2 path resolution registers the current root thread before resolving
relative or canonical targets. Agent paths (`/root`,
`/root/<task_name>`, …) are an **agent-tree namespace**, not filesystem
paths. Workers inherit cwd from the parent session/Environment section unless
worktree isolation changes their execution cwd.

### `spawn_agent` discipline (summary)

- Prefer concrete, self-contained sidecar tasks with disjoint write scopes.
- Use `isolation: "worktree"` (when available on the tool args path) for parallel
  writers that would otherwise collide.
- Omit `model` to inherit the parent model; override only when needed.
- `fork_turns`: omit (or use `"none"`) for the default clean fork; `"all"` for
  explicit full history; or a positive integer string for last-N turns.
  Full-history forks cannot combine with `agent_type` / `model` /
  `reasoning_effort` overrides.
- Swarm/delegation never expands tool, permission, approval, sandbox, capacity,
  admission, or budget authority. `spawn_agent` and `close_agent` are
  approval-bearing mutations; all coordination tools retain their normal
  policy classification.
- Call `wait_agent` sparingly — only when blocked on the next critical-path step.
- Treat worktree path and branch as locators only. Integrate only the exact
  immutable `base_commit..integration_ref` range from `committed_clean`
  evidence, one worker range at a time (or through one dedicated integration
  worker in coordinator mode), and run verification after each integration.

### Worktree evidence

After an isolated turn, AgenC captures a read-only Git snapshot:

| Evidence state | Reusable/integrable truth |
| --- | --- |
| `committed_clean` | Clean changed HEAD descending from the captured base; the only state with exact `integration_ref`; advance the rolling base and allow reuse |
| `unchanged_clean` | No committed or uncommitted change; no integration reference; preserve/advance the rolling base and allow reuse |
| `dirty_uncommitted` | Uncommitted tracked or untracked output; no integration reference; stop reuse and retain evidence/worktree |
| `diverged` | Captured base is not an ancestor of HEAD; no integration reference; stop reuse and retain evidence/worktree |
| `unverifiable` | Evidence capture failed closed; no integration reference; stop reuse and retain evidence/worktree |

The path, branch, and Git root identify where retained work can be inspected.
They are mutable and never substitute for the exact commit object ID.
Task outcome and integration eligibility are independent: anything other than
`committed_clean` is non-integrable, while even `completed` plus
`committed_clean` is only eligible for parent review, not merge authorization.
The three fail-closed evidence states also prevent the worker from returning to
reusable `idle`; a later assignment cannot compound an unresolved worktree
state. See [swarm-orchestration.md](../design/swarm-orchestration.md) for the
full evidence and evaluation contract.

One turn may contain multiple commits. The immutable review boundary is the
captured `base_commit..integration_ref` range, including every commit and its
aggregate diff, not merely the HEAD commit viewed in isolation. Git status
excludes ignored files, so a clean state does not attest to ignored output. An
ignored deliverable must be explicitly unignored or force-added and committed
before the turn ends; never recover it later from the mutable worktree path.

### Adaptive `/swarm` mode

`/swarm on` enables the conservative routing policy documented in
[swarm-orchestration.md](../design/swarm-orchestration.md). One agent remains
the default. Parallel routing requires explicit parallelism, or explicit
independence plus a syntactic list; a list alone stays sequential. Qualifying
work can recommend two workers, or a guidance ceiling of four for four or more
listed items. Writable parallel work is advised to use worktrees. Root-turn
model guidance includes an `agenc.swarm.route.v1` audit receipt without copying
the raw prompt; the receipt is not a persisted event-log record or an enforced
admission limit.

### Coordinator mode

When coordinator mode is enabled (`coordinator_mode` config and/or
`AGENC_COORDINATOR_MODE`, gated by the `COORDINATOR_MODE` feature flag), the
LIVE registry keeps an orchestration-only tool allowlist
(`LIVE_COORDINATOR_ALLOWED_TOOLS` in `runtime/src/coordinator/coordinatorMode.ts`):

`spawn_agent`, `send_message`, `wait_agent`, `close_agent`, `list_agents`,
`assign_task`, `TaskOutput`, `TaskStop`, `AskUserQuestion`, `TodoWrite`.

The coordinator does not edit files or run shell commands itself — workers do.
For isolated writer evidence ranges, it assigns integration sequentially to a
single worker operating in the parent workspace rather than attempting git
operations itself.
See `getLiveCoordinatorSystemPrompt()` for the model-facing instructions.

## Background agents (daemon)

### CLI

```bash
agenc agent start [--unattended-allow <tools>] [--unattended-deny <tools>] <objective>
agenc agent list
agenc agent attach <id>
agenc agent stop <id>
agenc agent logs <id>
```

Unattended flags must come **before** the objective; the first non-flag token
ends option parsing (flags after the objective become part of the objective
text).

Source: `runtime/src/app-server/agent-cli.ts` (dispatched from `bin/agenc.ts`).
See also [cli.md](cli.md).

Related TUI: `/coordinator` (alias `/fleet`) toggles coordinator mode for the
session when the feature is available (`AGENC_COORDINATOR_MODE` /
`coordinator_mode`). `/tasks` surfaces live workers and shell tasks.

### Daemon methods (SDK + JSON-RPC)

| Method | Purpose |
| --- | --- |
| `agent.create` | Create / spawn a background agent |
| `agent.list` | List agents |
| `agent.attach` | Attach a client to a running agent |
| `agent.stop` | Stop an agent |
| `agent.logs` | Fetch agent logs |

SDK helpers on `AgencClient`: `spawnAgent`, `listAgents`, `attachAgent`,
`stopAgent`, `agentLogs`. See [`../sdk.md`](../sdk.md).

Background agents use the **unattended** permission policy when no interactive
client is attached (internal mode; not a user-facing CLI default). Unattended
allow/deny lists can be supplied at create time via CLI flags or the RPC.

The channel gateway provisions passive agents
(`initialContent: []` suppresses an objective turn) and adopts each agent's
session so one conversation maps to one agent = one session. Details:
[`../gateway.md`](../gateway.md).

## Roles, registry, worktrees

| Area | Location |
| --- | --- |
| Role definitions / presentation | `runtime/src/agents/role*.ts` |
| Registry / agent path helpers | `runtime/src/agents/registry.ts` |
| Worktree isolation | `runtime/src/agents/worktree.ts` |
| Thread / mailbox | `runtime/src/agents/thread*.ts`, `mailbox.ts` |
| Job orchestrator (CSV multi-spawn etc.) | `runtime/src/agents/jobs/` |
| TUI Agents rail | `runtime/src/tui/workbench/` (Agents pane at wide widths) |

### Workspace-scoped custom roles

Role discovery is tied to the session's immutable absolute workspace. The
execution cwd may move into a worktree, but role lookup, the model-facing role
catalog, nested spawn, resume, restart, and the TUI picker continue to use the
original session identity. Two live workspaces may therefore define the same
role name without sharing prompts or configuration.

New child metadata records the originating role-workspace ID. AgenC rejects a
named resume/restart when that ID is missing or does not match the session,
instead of silently selecting a same-named role from the current workspace.
Named custom-role teammates currently require in-process teammate mode. Pane
processes are rejected before launch because their startup protocol cannot yet
consume the complete exact-role prompt, policy, memory, workspace, and
fingerprint envelope; AgenC will not silently launch a default/unrestricted
agent in its place.
See [workspace-scoped agent-role identity](../design/workspace-scoped-agent-roles.md)
for the boundary and compatibility contract.

## Related slash commands

- `/agents` — interactive agent listing / management menu
- Protocol marketplace commands (`/claim`, `/delegate`, …) are separate from
  multi-agent v2; mutating marketplace stages remain owner-gated (see
  [`../roadmap.md`](../roadmap.md)).

## Validation

- Agent surface contract: `npm run check:agent-surface-contract`
- Multi-agent / tool-registry suites under `runtime/tests/`
- Eval gate after turn-loop changes: see [`../agent-eval-reports.md`](../agent-eval-reports.md)
