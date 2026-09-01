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

The six v2 tools are registered by `createMultiAgentV2Tools()`
(`runtime/src/agents/v2/index.ts`). CSV job tools are a sibling registration
in `runtime/src/bin/model-facing-tools.ts`, not inside `v2/index.ts`.

| Tool | Role |
| --- | --- |
| `spawn_agent` | Spawn a reusable worker and its initial bounded task. Required `message` + `task_name`. Optional `agent_type`, `model`, `reasoning_effort`, `service_tier`, `fork_turns`, `isolation` (`none` \| `worktree`). Blank optional strings are omitted. `fork_context` is accepted then rejected (`use fork_turns instead`). Preflight failures before `delegate()` are confirmed no-effect: [spawn preflight](#spawn_agent-preflight). |
| `wait_agent` | Wait for, then drain, all delivered mailbox updates. `timeout_ms` only (default 30s, min 10s, max 1h). No target filter. |
| `close_agent` | Terminally close a worker and its descendants. Argument and identity refusals before `shutdown()` are confirmed no-effect: [agent validation refusals](#agent-validation-refusals). |
| `assign_task` | Admit one new task to an idle reusable worker (**triggers a turn**). Argument, identity, and target-resolution refusals plus the four no-mutation admission rejections are confirmed no-effect: [agent validation refusals](#agent-validation-refusals). |
| `send_message` | Queue passive context (**does not** trigger a turn). The same pre-delivery refusals as `assign_task` are confirmed no-effect: [agent validation refusals](#agent-validation-refusals). |
| `list_agents` | Read the live agent tree and current statuses. Optional `path_prefix`. |
| `spawn_agents_on_csv` | Fan out workers from CSV rows (job orchestrator) |
| `report_agent_job_result` | Report a CSV/job worker result back to the orchestrator |
| `inspect_csv_agent_job` | Read a bounded job summary and keyset item page |
| `read_csv_agent_job_result` | Read one bounded base64 result chunk |
| `list_csv_job_reviews` | List a bounded page of unknown-outcome reviews |
| `show_csv_job_review` | Read one bounded review record |
| `resolve_csv_job_review` | Approval-gated operator resolution with canonical evidence |

### CSV job contract

CSV fan-out keeps three identities separate. A configured `source_id` is exact
user data, `item_id` is an opaque runtime-owned content identity, and worker
names use a safe runtime prefix plus row/hash material. Without `id_column`, no
source identity is invented. Duplicate, blank, oversized, malformed, or
reserved input is rejected before the atomic import visibility fence opens.

The approved instruction is passed unchanged in the task-instruction channel.
Runtime policy, approved task text, and every exact field from each inert,
null-prototype CSV row are digest-bound in a versioned invocation envelope.
Runtime policy uses the provider's privileged channel; task text and row data
use separate, non-merging user channels. Each row field carries its column,
row/item identity, byte length, and digest, so field contents cannot become
privileged instructions. Malformed envelopes fail before a child slot is
reserved. The spawn response contains contract version `1`, aggregate counters,
and at most the first 20 item summaries without result bodies.
`inspect_csv_agent_job` provides keyset pages (maximum 100 items), and
returns an opaque `next_cursor` when another page exists. Supply that token
unchanged as the next call's `cursor`; it is bound to the job and item-status
filter, and forged, stale, or cross-job tokens are rejected. Do not decode it or
construct pagination from row/item IDs. `read_csv_agent_job_result` returns at
most 64 KiB of one result as base64.

Dispatch is at-most-once by default. A process restart replays a dispatched
item only when a registered versioned idempotency profile, its persisted
operation key, provider acknowledgement, and a bounded authoritative lookup
all prove the retry safe. Other interrupted dispatches enter
`unknown_outcome` and hold the job in `needs_review`. Cancellation leaves
undispatched rows cancelled and treats unresolved dispatched rows as
ambiguous; capacity is released only after the worker exits or is explicitly
retired.

#### Unknown-outcome operator review

The daemon and SDK expose the same durable operator workflow through
`csvJob.review.list`, `csvJob.review.show`, and `csvJob.review.resolve`.
`AgencClient` provides `listCsvJobReviews`, `showCsvJobReview`, and
`resolveCsvJobReview`; the SDK fills an omitted `cwd` with the client's current
absolute working directory. List pages contain at most 100 bounded summaries
and use the repository's opaque, scope-bound cursor. Show responses bound long
source IDs, reasons, and evidence; oversized evidence is represented by its
byte count and SHA-256 digest instead of being embedded.

Resolution accepts an external evidence reference and lowercase SHA-256 digest
and persists the exact A1 operator-evidence record. Callers choose only the
disposition; the runtime derives the domain action:

| Disposition | Durable action |
| --- | --- |
| `confirmed_committed` | `mark_completed` (optionally with a recovered result object) |
| `confirmed_no_effect` | `retry_new_attempt` |
| `remains_unknown` | `abandon_item` |

The model-facing resolver is mutating and always requires explicit approval.
An identical request is idempotent across daemon restarts; the response reports
`already_resolved`. A different disposition, evidence identity, reviewer, or
recovered-result digest fails closed with `CSV_REVIEW_CONFLICT`. Operator
reason text is an audit annotation; evidence identity is the replay key.

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

A keep-alive worker that hits `max_turns`, `max_budget_usd`, the
no-progress backstop, or `compact_failed` returns to `idle` after that
turn. The same bounded stop on a one-shot / compatibility agent is
terminal (`errored` / failed run). Interactive session survival:
[daemon.md](daemon.md#interactive-session-survival). Compact skip:
[daemon.md](daemon.md#compact-skip-stays-per-turn).

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

Argument, identity, target-resolution, empty-message, and byte-cap refusals
happen before `assignTask()` / `sendInterAgentCommunication()` and attest
`confirmed_no_effect`. `assignTask()` also rejects self-target, non-ancestor
sender, non-idle worker, and an outstanding assignment before installing an
assignment marker or sending mail. Those four typed rejections receive the
same attestation. Mailbox backpressure and other unclassified delivery errors
remain ordinary `isError`. Detail:
[agent validation refusals](#agent-validation-refusals).

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

### `spawn_agent` task names

`task_name` becomes the child path segment. The public tool first trims a
nonempty string with `stringValue`; empty or whitespace-only input becomes a
missing value. `normalizeSpawnTaskName` in `runtime/src/agents/v2/spawn.ts`
then lowercases the value, changes runs of spaces or hyphens and other
characters outside `[a-z0-9_]` to `_`, collapses repeated `_` characters, and
removes `_` from both ends. If a nonempty input folds to an empty string, the
function keeps the trimmed input so `assertValidAgentName` in
`runtime/src/agents/registry.ts` can return the specific validation error.

| Input | Path segment |
| --- | --- |
| `review-patch` / `Review Patch` | `review_patch` |
| `plan#1` | `plan_1` |
| `root`, `.`, `..` | rejected (`agent_name` reserved) |
| empty / whitespace-only | rejected (`task_name is required`) |
| `---` or a Unicode-only name | rejected (`agent_name` charset check) |
| `/` | rejected (slash validation) |

After the fold the name must be nonempty `[a-z0-9_]+` and must not
contain `/`. Worktree isolation uses that same segment in the derived
slug; a rejected name never reaches Git.

Version-2 DAG children do not take this `task_name` path. Their registry
names are derived in [workflows.md](workflows.md#child-identity).

| Symptom | What to check |
| --- | --- |
| `agent_name must use only lowercase letters, digits, and underscores` | The fold was empty and the original nonempty string was kept for validation, as with `---` or a Unicode-only name. |
| ``agent_name `root` is reserved`` | `task_name` folded to `root`. Pick another name. |
| ``agent_name `.` is reserved`` / ``agent_name `..` is reserved`` | The fold was empty and the original `.` or `..` was kept for reserved-name validation. |
| `` agent_name must not contain `/` `` | The fold was empty and the original slash-only name was kept for slash validation. |

### `spawn_agent` preflight

`createSpawnAgentTool` in `runtime/src/agents/v2/spawn.ts` validates the
call, then calls `delegate()`. A child thread or worktree can exist only
after that boundary. Failures **before** `delegate()` use
`validationErrorToolResult` so the admitted-mutation gate does not treat
the refusal as an unknown-outcome effect.

| Field | Evidence |
| --- | --- |
| `disposition` | `confirmed_no_effect` |
| `evidenceKind` | `boundary_not_crossed` |
| `evidenceRef` | `tool:agents.spawn-agent:validation` |

Blank optional strings are omitted. `stringValue` in
`runtime/src/agents/v2/common.ts` keeps a trimmed nonempty string and
drops `""`, whitespace-only strings, and non-strings. That applies to
`agent_type`, `model`, `reasoning_effort`, `service_tier`, `fork_turns`,
and `isolation`. The same helper also reads `message` and `task_name`;
those two remain required after the trim.

```json
{
  "message": "review game.py",
  "task_name": "reviewer",
  "agent_type": "",
  "model": "",
  "reasoning_effort": "",
  "service_tier": "",
  "fork_turns": "",
  "isolation": ""
}
```

That call is a clean-fork inherit spawn: no role, model, effort, tier,
fork window, or worktree is forwarded to `delegate()`.

Preflight covers missing session, extra/unknown args, non-string fields,
empty `message`, rejected `fork_context`, role-workspace mismatch, the
current-agent context, invalid `reasoning_effort`, full-history plus
override, invalid `isolation`, unknown `agent_type`, model/effort/tier
override lookup (including a thrown model list), and `task_name`
validation. `delegate()` is not called on those paths.

Failures **at or after** `delegate()` stay ordinary `isError` results
without `confirmed_no_effect`. Child or worktree creation may have
started, so the gate must not claim the call touched nothing.

| Symptom | What to check |
| --- | --- |
| `confirmed_no_effect` / `boundary_not_crossed` on spawn | Preflight rejected the args or override lookup. No child or worktree was created. Fix the field and retry. |
| Ordinary `isError` spawn without that disposition | `delegate()` was entered. Inspect the child registry and any derived worktree before retrying. |
| Blank `model` / `reasoning_effort` / `isolation` still inherited the parent | Expected. Empty optional strings are omitted, not rejected. |
| `invalid reasoning_effort` | Nonempty value was not `low` / `medium` / `high` / `xhigh` / `none`. |
| `isolation must be \`none\` or \`worktree\`` | Nonempty `isolation` was something else. Use `""` to omit. |

`close_agent`, `assign_task`, and `send_message` use a sibling helper and a
different evidence ref:
[agent validation refusals](#agent-validation-refusals).

### Agent validation refusals

`close_agent`, `assign_task`, and `send_message` are `side-effecting`. The
live dispatcher (`executePhysical` in `runtime/src/tools/execution.ts`)
calls `onEffectBoundaryCrossed()` **before** `tool.execute()`. A bare
`isError` from those tools therefore poisons the session's unknown-outcome
mutation gate and blocks later `FileWrite` / `Bash` / `spawn_agent` until
`/resolve`, even when execute never mutated a child, mailbox, or shutdown
path.

Shared helpers in `runtime/src/agents/v2/common.ts`
(`agentValidationError`, `confirmedNoAgentEffect`) wrap those pre-mutation
refusals with `validationErrorToolResult`. `assign_task` may also use the
helper for the four typed `AgentAssignmentRejectedError` codes whose guards
run before the assignment marker is installed. Other errors after
`assignTask()`, `sendInterAgentCommunication()`, or `shutdown()` is entered
stay unclassified.

| Field | Evidence |
| --- | --- |
| `disposition` | `confirmed_no_effect` |
| `evidenceKind` | `boundary_not_crossed` |
| `evidenceRef` | `tool:agents.v2:validation` |

`spawn_agent` keeps its own ref (`tool:agents.spawn-agent:validation`):
[spawn preflight](#spawn_agent-preflight).

| Tool | Attested before | Still unknown-effect after |
| --- | --- | --- |
| `close_agent` | Extra/unknown args, missing `target`, missing session, invalid runtime identity, unresolved target, `root is not a spawned agent` | `control.shutdown()` throw (`close failed`, …). `collab_close_begin` has already been emitted. |
| `assign_task` | Extra/unknown args, missing `target` / `message`, empty or whitespace-only message, 65,536-byte cap, missing session, invalid runtime identity, unresolved target, self-message, root target, missing `agent_path`; typed `self_target`, `sender_not_ancestor`, `worker_not_idle`, and `assignment_outstanding` admission rejections | `mailbox_backpressure`, closed-worker, or another unclassified error from `assignTask()`. `collab_agent_interaction_begin` has already been emitted. |
| `send_message` | The same argument, identity, resolution, size, self-message, and missing-path refusals | Any error from `sendInterAgentCommunication()`. `collab_agent_interaction_begin` has already been emitted. |

```json
{
  "target": "/root",
  "message": "run this"
}
```

That `assign_task` call returns
`Tasks can't be assigned to the root agent` with
`confirmed_no_effect` / `boundary_not_crossed`. No mailbox item is
enqueued. The same `/root` target on `close_agent` returns
`root is not a spawned agent` with the same disposition. A later
`FileWrite` in the same session is not gated.

| Symptom | What to check |
| --- | --- |
| `confirmed_no_effect` / `tool:agents.v2:validation` on close / assign / send | Pre-mutation refusal. No child shutdown, assignment marker, or mailbox send ran. Fix the field or target and retry. Do not `/resolve`. |
| Ordinary `isError` without that disposition after close / assign / send | `shutdown()`, `assignTask()`, or `sendInterAgentCommunication()` was entered. Inspect the worker and mailbox before retrying. Later FileWrite / Bash / spawn stay blocked until `/resolve`. |
| `unknown field \`interrupt\`` / `unknown field \`items\`` with `confirmed_no_effect` | Extra args. `send_message` has no `interrupt`; `assign_task` has no `items`. |
| `Empty message can't be sent to an agent` / `message exceeds the 65536-byte inter-agent limit` | Message refused before delivery. Whitespace-only strings and UTF-8 over the byte cap are both attested no-effect. |
| `agent reference cannot be resolved` / `invalid-runtime-identity` | Target or signed session identity failed before delivery. |
| `agent ... is not an idle reusable worker` / `must be a strict ancestor` / `already has an outstanding assignment` | A typed admission guard rejected before an assignment marker or mailbox send. The result is `confirmed_no_effect`; fix the target state and retry without `/resolve`. |
| Assignment reports mailbox backpressure or an untyped delivery error | The no-mutation classifier cannot prove this path. Inspect the worker and mailbox before resolving or retrying. |

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
the default. Parallel routing requires explicit parallelism, explicit
independence plus a syntactic list, or a multi-domain review/research list; a
list alone stays sequential. A parallel decision force-selects `spawn_agent`
for its first provider request, requiring a real spawn attempt while leaving
approval, capacity, sandbox, and admission checks intact. Qualifying work can
use two workers, or a ceiling of four for four or more listed items. Writable
parallel work is advised to use worktrees. Root-turn model guidance includes an
`agenc.swarm.route.v2` audit receipt without copying the raw prompt; the receipt
is not a persisted event-log record.

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

Source: `runtime/src/app-server/agent-cli.ts` (dispatched from `bin/agenc-main.ts`).
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

`agent.create` accepts `deferInitialTurn: true` to provision a live session
without submitting a first model turn (Editor cold-start). Startup hooks
and Agent side effects stay deferred until the first non-Editor message.
The flag cannot combine with `initialContent` or other first-turn fields
(`runtime/src/app-server/daemon-dispatcher.ts`). The thread sits in
`pending_init`; `ifBusy: "reject"` on `message.send` refuses only an
in-flight or queued turn, not `pending_init`. Rejecting the first prompt would
deadlock the session. See [daemon.md](daemon.md).

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

Built-in role IDs are their public names:

| Role | Purpose |
| --- | --- |
| `scanner` | Read-only codebase reconnaissance |
| `runner` | Execution and production work |

The removed `explorer` and `worker` built-in IDs are not accepted as aliases.
Use the canonical role names in `agent_type`, persisted metadata, role files,
and automation.

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

## Turn abort containment

A session's `abortController` is **one-shot for the session lifetime**.
Burning it on a child interrupt or a mid-turn tool abort left every later
turn born aborted: the session stayed listed as live and silently dropped
each following message.

| Surface | What is aborted | Source |
| --- | --- | --- |
| Fork / conversation interrupt | Only the fork turn's `activeTurnAbort` scope | `runtime/src/conversation/thread-manager.ts` (`ForkedConversationThread.submit`) |
| Mid-turn tool abort | The **active turn** task controller (`session.activeTurn.abortController`) | `runtime/src/phases/execute-tools.ts` |
| Process / stdin / permission-authority death | `session.abortTerminal(...)`; still ends the session | `session.ts`, daemon / CLI signal paths |

Fork interrupt used to call `sourceSession.abortTerminal()`. That cut through
the turn lock but aborted the shared parent terminal controller. An interrupt
while a spawned child was open then poisoned the parent. Interrupt now aborts
exactly that fork turn and skips the queue; the next turn gets a fresh signal.

Tool-use context builders must not alias `session.abortController` as the
context controller. The agent/tool runtime aborts that handle to cancel work;
if it is the session controller, one Stop during `wait_agent` consumes the
session. Session-wide abort still cascades into the child scope.

Sibling-tool cancellation emits a live `warning` (`sibling_tool_abort`). It
does not abort the session.

## Related slash commands

- `/agents` interactive agent listing / management menu
- `/coordinator` (alias `/fleet`) reports or toggles coordinator mode
- `/swarm` reports or sets adaptive routing (`on` / `off` / `status`)
- `/tasks` live workers and shell tasks
- Protocol marketplace commands (`/claim`, `/delegate`, …) are separate from
  multi-agent v2. Mutating marketplace stages remain owner-gated (see
  [`../roadmap.md`](../roadmap.md)).

## Validation

- Agent surface contract: `npm run check:agent-surface-contract`
- Multi-agent / tool-registry suites under `runtime/tests/`
- Eval gate after turn-loop changes: see [`../agent-eval-reports.md`](../agent-eval-reports.md)
