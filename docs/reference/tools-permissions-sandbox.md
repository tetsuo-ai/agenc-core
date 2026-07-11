# Tools, permissions & sandbox

How model tool calls move from the provider response to execution — and what
can stop them.

## Tool catalogs (do not confuse them)

| Surface | Location | Who sees it |
| --- | --- | --- |
| **LIVE model-facing registry** | `runtime/src/tool-registry.ts` + `runtime/src/bin/model-facing-tools.ts` + `runtime/src/tools/system/*` | The model / daemon turn loop (`toLLMTools()` → provider payload; `dispatch()` → execution) |
| **TUI tool pool** | `runtime/src/tools.ts` (`getAllBaseTools()`) | Historical / TUI-side presentation pool — **not** the LIVE catalog. Overlaps names with LIVE but omits many LIVE tools and uses donor-era shapes (`CanonicalBashTool`, etc.) |
| **MCP bridge tools** | `runtime/src/mcp-client/tools.ts` via `mcpToolsProvider` on the registry | Namespaced `mcp.<server>.<tool>` on the LIVE surface (usually deferred until `system.searchTools`) |

**Rule of thumb:** if you are changing what the model can call in a real turn,
edit the LIVE path (`buildToolRegistry` / `createModelFacingTools` /
`tools/system/*`). Editing `tools.ts` alone does **not** register a LIVE tool.

Assembly wiring:

1. `bin/bootstrap-tool-registry.ts` → `createModelFacingTools()` + `buildToolRegistry()`
2. `tool-registry.ts` registers system groups + injects model-facing tools
3. Provider payload = request-scoped visible set; deferred tools appear after
   discovery (`system.searchTools` / `discoverToolNames`)

Unified execution path: `runtime/src/tools/execution.ts` (`runToolUse`) —
permissions, transaction guard, then `Tool.execute()`.

Web search provider selection:
[`../../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md`](../../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md).

Provider tool-schema normalization (strict OpenAI-compatible roots):
[`../provider-tool-compat.md`](../provider-tool-compat.md).

---

## LIVE tool catalog (by family)

Names below are the **registered** LIVE tool names from
`buildToolRegistry()` and `createModelFacingTools()`. Visibility is
request-scoped: a smaller default-visible set is advertised every turn;
deferred / hidden tools stay in the catalog and load via
`system.searchTools` (or config / discovery). Config
(`[tools]` / `toolsConfig`) can disable individual tools.

Do **not** treat the TUI pool (`tools.ts`) as authoritative for this list.

### Files (first-class)

| Name | Notes |
| --- | --- |
| `FileRead` | Canonical read |
| `Edit` | Single-file edit (read-before-write + mtime drift) |
| `MultiEdit` | Multi-hunk edit on one file |
| `Write` | Create / overwrite |
| `Glob` | Path glob |
| `Grep` | Content search (prefer over shell `rg`/`grep`) |
| `Orient` | Workspace orientation helper |
| `apply_patch` | Multi-file transactional patch |

### Filesystem compatibility (`tools/system/filesystem.ts`)

Legacy `system.*` utilities (not the primary edit surface):

| Name |
| --- |
| `system.listDir` |
| `system.stat` |
| `system.mkdir` |
| `system.delete` |
| `system.move` |

### Shell / process

| Name | Notes |
| --- | --- |
| `exec_command` | **Canonical** shell (unified-exec) |
| `write_stdin` | Write to a running unified-exec process |
| `kill_process` | Kill a managed process |
| `system.bash` | Direct/shell fallback — **deferred** by default; prefer `exec_command` |
| `PowerShell` | Registered only when `pwsh`/`powershell` is on `PATH` **and** a unified-exec manager is available; **deferred** |

### Search / discovery / code intel

| Name | Notes |
| --- | --- |
| `system.searchTools` | Discover deferred tools into the visible catalog |
| `system.repoInventory` | Deferred code-intel |
| `system.gitStatus` | Deferred |
| `system.gitDiff` | Deferred |
| `system.gitShow` | Deferred |
| `system.gitBranchInfo` | Deferred |
| `system.gitChangeSummary` | Deferred |
| `system.gitWorktreeList` | Deferred |
| `system.gitWorktreeCreate` | Deferred |
| `system.gitWorktreeRemove` | Deferred |
| `system.gitWorktreeStatus` | Deferred |
| `system.symbolSearch` | Deferred |
| `system.symbolDefinition` | Deferred |
| `system.symbolReferences` | Deferred |
| `LSP` | Language-server diagnostics / definition / references / symbols |
| `WebSearch` | Web search (provider-native Grok path when available, else configured endpoint / DuckDuckGo) |
| `web_fetch` | Fetch URL → text/markdown |
| `WebFetch` | Legacy alias of `web_fetch` |

There is **no** separate LIVE tool named `web_search`; that string is only a
provider-native server-side tool id used internally by the Grok web-search
path. Model-facing search is `WebSearch`.

### Planning / workflow

| Name | Notes |
| --- | --- |
| `TodoWrite` | Checklist / todo list |
| `EnterPlanMode` | Enter plan permission posture |
| `ExitPlanMode` | Exit plan mode (approval path) |
| `VerifyPlanExecution` | Compare plan vs progress summary |
| `WorkflowTool` | Agent workflow runner |
| `CronCreate` / `CronDelete` / `CronList` | Local scheduled prompts (`.agenc/scheduled_tasks.json`) |
| `RemoteTrigger` | Deferred; inspect local scheduled defs only |

### Interaction / user input

| Name | Notes |
| --- | --- |
| `AskUserQuestion` | Multi-choice questions (TUI picker) |
| `request_user_input` | Elicitation / free-form user input |
| `request_ledger_transfer` | Built-in typed Android/Ledger SOL transfer handoff; exact active root-turn `@ledger` authorization only |
| `Brief` | Short progress message to the user |
| `SendUserMessage` | Alias of Brief-style progress message |
| `Sleep` | Sleep / yield |
| `Monitor` | Monitor a background command/process |

### Worktree

| Name |
| --- |
| `EnterWorktree` |
| `ExitWorktree` |

### Browser

| Name | Notes |
| --- | --- |
| `Browser` | Deferred. Drives an isolated Chromium (CDP over `--remote-debugging-pipe`) with a single `action` param: `navigate`, `snapshot`, `click`, `type`, `press_key`, `scroll`, `screenshot`, `get_text`, `new_tab`, `tabs`, `select_tab`, `close_tab`. Elements are addressed by stable `[ref=eN]` accessibility refs, never CSS selectors. |

All browser egress is forced through an in-process loopback proxy that resolves
each host once and connects to that exact IP (no DNS-rebinding window); private,
loopback, and cloud-metadata addresses are blocked by default (`[browser]
allow_private_network` opts in for local-dev targets; metadata stays blocked
regardless, in every address representation). Non-proxied WebRTC UDP is disabled
so it cannot open a side channel around the proxy. The browser uses a dedicated profile under
`<agenc_home>/browser/profile`, never the user's real profile, and launches
lazily on first use. `snapshot` / `screenshot` / `get_text` / `tabs` are
read-only and auto-approved; `navigate` and acting actions prompt in default
mode (`navigate` can be granted a persistent per-domain allow rule). Config:
`[browser]` (`executable_path`, `headless`, `allow_private_network`,
`profile_dir`, `no_sandbox`, `navigation_timeout_ms`) + `AGENC_BROWSER_*` env.
See the bundled `browser-automation` skill for the snapshot→act→re-snapshot
workflow.

### Notebook

| Name |
| --- |
| `NotebookRead` |
| `NotebookEdit` |

### Skill

| Name | Notes |
| --- | --- |
| `Skill` | Invoke a skill by name (`skill` / `name` + optional `args`) |

### Task board / background tasks

| Name | Notes |
| --- | --- |
| `TaskCreate` | Task board |
| `TaskGet` | Task board |
| `TaskUpdate` | Task board |
| `TaskList` | Task board |
| `TaskOutput` | Background task output |
| `TaskStop` | Stop background task |

### Multi-agent v2 + jobs

Canonical v2 surface (`runtime/src/agents/v2/`). Details:
[`agents.md`](agents.md).

| Name | Notes |
| --- | --- |
| `spawn_agent` | Spawn worker |
| `wait_agent` | Wait for worker result |
| `close_agent` | Tear down worker |
| `assign_task` | New task (triggers turn) |
| `send_message` | Follow-up (no turn trigger) |
| `list_agents` | Inspect agent tree |
| `spawn_agents_on_csv` | Batch CSV agent jobs |
| `report_agent_job_result` | Record CSV job item result |

### MCP helpers (built-in) + bridge

| Name | Notes |
| --- | --- |
| `ListMcpResourcesTool` / `ListMcpResources` | List MCP resources (deferred) |
| `ReadMcpResourceTool` / `ReadMcpResource` | Read MCP resource (deferred) |
| `mcp.<server>.<tool>` | Live tools from configured MCP servers (usually deferred until discovery) |

### Structured output / code-mode

| Name | Notes |
| --- | --- |
| `StructuredOutput` | Schema-bound when session has `outputSchema`; otherwise deferred passthrough |
| `exec` | Code-mode JS exec — only when code-mode service enabled |
| `wait` | Code-mode wait — only when code-mode service enabled |

### Default-visible vs deferred (high level)

Exact visibility is request-scoped and config-dependent. As coded in
`buildToolRegistry` defaults:

- **Typically advertised early:** `exec_command`, `write_stdin`, `kill_process`,
  `FileRead`, `Edit`, `MultiEdit`, `Write`, `Glob`, `Grep`, `Orient`,
  `AskUserQuestion`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode`,
  `system.searchTools`, plus non-deferred model-facing tools (web, multi-agent
  v2, tasks, Skill, etc.).
- **Deferred / discoverable examples:** `system.bash`, git/symbol `system.*`
  intel tools, MCP tools when `deferMcpTools` is on, MCP resource helpers,
  `RemoteTrigger`, passthrough `StructuredOutput`, and other tools marked
  `metadata.deferred`.

Coordinator mode further **allowlists** orchestration tools only — see
[`agents.md`](agents.md).

---

## TUI pool (`tools.ts`) — dual catalog note

`runtime/src/tools.ts` still exports a donor-era **TUI / presentation** pool
via `getAllBaseTools()`. It is useful for UI filtering and historical parity,
but it is **not** what `buildToolRegistry` advertises to the model.

Notable differences (non-exhaustive):

| Topic | LIVE | TUI pool |
| --- | --- | --- |
| Shell | `exec_command` (+ deferred `system.bash`) | `CanonicalBashTool` (bash-shaped) |
| Files | `FileRead` / `Edit` / `Write` / `MultiEdit` / `apply_patch` | Canonical read/edit/write/notebook set |
| Multi-agent | `spawn_agent` family | Not assembled here (Team\* gated) |
| Discovery | `system.searchTools` + deferred system intel | Optional `ToolSearchTool` |
| Code-mode | `exec` / `wait` when enabled | Not in pool |
| Authority | Daemon turn loop | Presentation / legacy |

When docs or code comments say “registered tools”, assume LIVE unless they
explicitly cite `tools.ts`.

---

## Permission modes

Source of truth: `runtime/src/permissions/types.ts` (and
`runtime/src/types/permissions.ts`).

**User-addressable** (`--permission-mode`, settings, slash `/permissions`):

| Mode | Intent |
| --- | --- |
| `default` | Ask on sensitive / unmatched actions |
| `acceptEdits` | Auto-approve common edit-class actions; still gate higher risk |
| `plan` | Planning posture (plan banner in TUI); constrained execution |
| `bypassPermissions` | YOLO-style skip of approval prompts (deny floor remains; not a sandbox disable) |
| `dontAsk` | Deny rather than prompt when an ask would be required |
| `auto` | Classifier-assisted auto decisions |

**Internal-only** (valid runtime state, not CLI defaults):

| Mode | Intent |
| --- | --- |
| `unattended` | Background agents with no attached client; policy allow/deny/pause |
| `bubble` | Nested/child contexts that bubble denials to the parent |

The daemon permission overlay classifies low / medium / destructive requests.
Destructive requests require typed confirmation; low/medium use engine
allow/reject callbacks and `confirm:yes` keybinding shortcuts.

### Mobile session-wide approval

Remote clients may settle the currently pending request with
`scope: "session", allowAllToolsForSession: true`. This is an explicit opt-in
that transactionally promotes the owning daemon session to
`bypassPermissions`; it is not implied by ordinary session-scoped approval.
If the pending request is stale or settlement throws, Core restores the prior
permission context. The mode is session-local and does not authorize another
session or remove OS sandbox boundaries.

### `@ledger` turn policy

`request_ledger_transfer` is a privileged interaction tool with no
model-directed filesystem writes. It is available only when the exact active
root-human turn contains `@ledger`, and one atomic claim permits a single call
for that turn. Subagents and synthetic/autonomous turns cannot inherit the
token from prompt text or durable history.

During that turn, the router denies every other tool unless it is explicitly
read-only and has no mutating, interactive, or side-effecting metadata. The
tool accepts only a Solana recipient, positive decimal lamports, and an optional
short note, then emits a typed client action for a capable Android phone.
Physical approval and receipt validation are described in
[`../security/mobile-ledger-transfer.md`](../security/mobile-ledger-transfer.md).

### Rules, trust, unattended

- Rule evaluation / sources: `runtime/src/permissions/rules.ts`,
  `evaluator.ts`, `settings.ts`
- Project trust: `runtime/src/permissions/trust/`
- Unattended policy: `runtime/src/permissions/unattended-policy.ts`
- Approval cache / grants / audit log under `runtime/src/permissions/`
- Network approval: `network-approval.ts`
- Guardian / arbiter (reviewer circuit): `permissions/guardian/`

CLI: `agenc permissions …` and TUI `/permissions`.

## Sandbox

OS-level confinement for shell execution lives in `runtime/src/sandbox/`:

| Platform | Engine |
| --- | --- |
| Linux | bubblewrap + Landlock helpers (`engine/bwrap.ts`, `engine/landlock.ts`, `linux-launcher/`) |
| macOS | Seatbelt policies (`engine/seatbelt.ts`, `engine/policies/*.sbpl`) |

Runtime `read_only` and `workspace_write` profiles use a full-disk read
baseline. Explicit deny-read entries still override it. `read_only` grants no
write entries; `workspace_write` grants writes only to the workspace, approved
temporary paths, and explicit policy roots. Resolved write targets are checked
through the canonical permission profile before execution. This preserves the
agent's ability to inspect dependencies and toolchains outside the checkout
without granting writes there.

Related:

- Permission-side sandbox policy glue: `runtime/src/permissions/sandbox.ts`
- Exec policy language: `runtime/src/sandbox/execpolicy/`
- Network policy: `runtime/src/sandbox/network-policy.ts`
- Escalation / approvals: `runtime/src/sandbox/escalation/`

`--yolo` / `bypassPermissions` waives **approval prompts**, not kernel
confinement. Sandbox must be explicitly enabled/configured to confine process
execution. Docker sandbox driver and SSH remote exec targets remain roadmap
items ([`../roadmap.md`](../roadmap.md)).

## Pre-execute guards

Order of concern on the LIVE path (conceptually):

1. **Permission mode + rules** → allow / deny / ask
2. **SLM transaction guard** (opt-in) for Solana-like mutating calls —
   fail closed by default ([`../security/slm-transaction-guard.md`](../security/slm-transaction-guard.md))
3. **OS sandbox** (when enabled) around shell / unified-exec
4. **Tool-specific safety** (read-before-write + mtime drift on edits;
   transactional multi-file `apply_patch`; bash dangerous-pattern checks)

Mutating file tools refuse silent clobber when disk state drifted under the
agent; `apply_patch` plans in memory, commits, and rolls back on any failure.

## Autonomous spend

Heartbeat, cron delivery, and hooks are gated by the budget layer when enabled
— see [`autonomy.md`](autonomy.md) and
[`../design/budget-enforcement.md`](../design/budget-enforcement.md). Budget is
orthogonal to permission modes: a turn can be permission-approved and still
refused as `BUDGET_EXCEEDED`.

## Multi-agent tools

See [`agents.md`](agents.md) for `spawn_agent` / `wait_agent` / `close_agent` /
`assign_task` / `send_message` / `list_agents`.

## Related CLI / TUI

- `/permissions`, `/mcp`, `/hooks`, `/skills`, `/plugins`, `/agents`
- `agenc doctor` — includes transaction-guard status
- `agenc security audit` — exposure / posture checks
