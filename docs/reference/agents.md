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

Registered by `createMultiAgentV2Tools()`:

| Tool | Role |
| --- | --- |
| `spawn_agent` | Spawn a worker for a bounded task |
| `wait_agent` | Block only when the worker result is the immediate critical-path need |
| `close_agent` | Close / tear down a worker |
| `assign_task` | Give a running worker a new task (**triggers a turn**) |
| `send_message` | Follow-up to a running worker (**does not** trigger a turn) |
| `list_agents` | Inspect workers in the agent tree |

### Behavior invariants

- `assign_task` and `send_message` share strict `target` + `message` validation
  and the same event envelope. Difference is `triggerTurn: true` vs `false`.
- `assign_task` rejects assigning work to the root agent and does not enqueue
  root mail on that failure.
- Completed live agents remain reusable for later trigger-turn work.
- All v2 path resolution registers the current root thread before resolving
  relative or canonical targets.
- Agent paths (`/root`, `/root/<task_name>`, …) are an **agent-tree namespace**,
  not filesystem paths. Workers inherit cwd from the parent session / Environment
  section.

### `spawn_agent` discipline (summary)

- Prefer concrete, self-contained sidecar tasks with disjoint write scopes.
- Use `isolation: "worktree"` (when available on the tool args path) for parallel
  writers that would otherwise collide.
- Omit `model` to inherit the parent model; override only when needed.
- `fork_turns`: omit for full-history inheritance; `"none"` for a clean fork;
  `"all"` explicit full history; or a positive integer string for last-N turns.
  Full-history forks cannot combine with `agent_type` / `model` /
  `reasoning_effort` overrides.
- Call `wait_agent` sparingly — only when blocked on the next critical-path step.

### Coordinator mode

When coordinator mode is enabled (`coordinator_mode` config and/or
`AGENC_COORDINATOR_MODE`, gated by the `COORDINATOR_MODE` feature flag), the
LIVE registry keeps an orchestration-only tool allowlist
(`LIVE_COORDINATOR_ALLOWED_TOOLS` in `runtime/src/coordinator/coordinatorMode.ts`):

`spawn_agent`, `send_message`, `wait_agent`, `close_agent`, `list_agents`,
`assign_task`, `TaskOutput`, `TaskStop`, `AskUserQuestion`, `TodoWrite`.

The coordinator does not edit files or run shell commands itself — workers do.
See `getLiveCoordinatorSystemPrompt()` for the model-facing instructions.

## Background agents (daemon)

Daemon methods (SDK + JSON-RPC):

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
allow/deny lists can be supplied at create time.

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

## Related slash commands

- `/agents` — interactive agent listing / management menu
- Protocol marketplace commands (`/claim`, `/delegate`, …) are separate from
  multi-agent v2; mutating marketplace stages remain owner-gated (see
  [`../roadmap.md`](../roadmap.md)).

## Validation

- Agent surface contract: `npm run check:agent-surface-contract`
- Multi-agent / tool-registry suites under `runtime/tests/`
- Eval gate after turn-loop changes: see [`../agent-eval-reports.md`](../agent-eval-reports.md)
