# Tools, permissions & sandbox

How model tool calls move from the provider response to execution — and what
can stop them.

## Tool catalogs (do not confuse them)

| Surface | Location | Who sees it |
| --- | --- | --- |
| **LIVE model-facing registry** | `runtime/src/tool-registry.ts` + `runtime/src/bin/model-facing-tools.ts` + `runtime/src/tools/` | The model / daemon turn loop |
| **TUI tool pool** | historical `src/tools.ts` / TUI-side catalog notes | UI presentation — **confirm which catalog you are editing** |
| **MCP bridge tools** | `runtime/src/mcp-client/tools.ts` | Namespaced `mcp.<server>.<tool>` on the LIVE surface |

Built-in families under `runtime/src/tools/` include: Bash / PowerShell,
file read/write/edit, `apply_patch`, Glob/Grep, WebFetch/WebSearch, LSP, MCP
helpers, multi-agent v2 (`spawn_agent` …), Task\*, Skill, cron schedule tools,
plan mode enter/exit, worktree enter/exit, and more.

Unified execution path: `runtime/src/tools/execution.ts` (`runToolUse`) —
permissions, transaction guard, then `Tool.execute()`.

Web search provider selection:
[`../../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md`](../../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md).

Provider tool-schema normalization (strict OpenAI-compatible roots):
[`../provider-tool-compat.md`](../provider-tool-compat.md).

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
