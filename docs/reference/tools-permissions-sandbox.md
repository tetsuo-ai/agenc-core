# Tools, permissions & sandbox

How model tool calls move from the provider response to execution — and what
can stop them.

## Tool catalogs (do not confuse them)

| Surface | Location | Who sees it |
| --- | --- | --- |
| **Model-facing authority** | `runtime/src/tool-registry.ts` + `runtime/src/bin/model-facing-tools.ts` + `runtime/src/tools/system/*` | The model / daemon turn loop (`toLLMTools()` → provider payload; `dispatch()` → execution) |
| **Local TUI and worker pool** | `runtime/src/tools.ts` (`getAllBaseTools()`) | Permission presets, AgentTool workers, and REPL primitives. This pool is not model-facing authority. |
| **MCP bridge tools** | `runtime/src/mcp-client/tools.ts` via `mcpToolsProvider` on the registry | Namespaced `mcp.<server>.<tool>` on the model-facing surface (usually deferred until `system.searchTools`) |

**Rule of thumb:** if you are changing what the model can call in a real turn,
edit the model-facing path (`buildToolRegistry` / `createModelFacingTools` /
`tools/system/*`). Editing `tools.ts` alone does not register a model-facing tool.

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
| `apply_patch` | Multi-file transactional patch; **deferred** by default (not in `visibleByDefault`) |

#### Search execution and limits

`Grep`, `Glob`, and `Orient` execute only the absolute ripgrep binary supplied by AgenC's
lockfile-pinned `@vscode/ripgrep` package, always with `--no-config` and without
following symlinks. They do not resolve `rg` through `PATH` and have no
JavaScript regex or glob-search fallback. If the packaged executable is missing
or not executable, run `agenc doctor`, confirm the AgenC version, and reinstall
that same version.

Content/context results use ripgrep's incremental JSON protocol. File summaries
use NUL-terminated paths, and count summaries use NUL-delimited paths followed
by strict decimal counts. `Glob` and `Orient` file enumeration is likewise
NUL-delimited, so a newline in one pathname cannot invent multiple results.
Scoped searches snapshot verified parent-root ignore bytes and pass private
copies to ripgrep; they do not hand a previously admitted workspace ignore
pathname back to the subprocess to reopen after a race window.
Control-byte paths are escaped for display; invalid UTF-8 paths carry an
explicit `path-encoding=bytes` marker where byte-safe display is permitted and
are rejected when descriptor validation or line-oriented orientation output
cannot represent them safely.

Portable input maxima are 65,536 UTF-8 bytes for the pattern and raw glob,
16,384 bytes per glob and raw path, 256 globs, 256 bytes for `type`, 10,000
context lines, 100,000 returned results, a 100,000 `head_limit`, and a 1,000,000
offset. A `Glob` pattern is one glob entry and therefore uses the 16,384-byte
per-glob ceiling. The complete POSIX argv is capped at 262,144 UTF-8 bytes. Windows also
applies the stricter serialized non-verbatim command-line ceiling of 30,000
UTF-16 code units, including executable, separators, quoting expansion, and the
terminal NUL; an input can therefore pass the portable byte limit and still be
rejected on Windows. `head_limit: 0` removes user pagination only, not the hard
record, decoded-output, 32 MiB rendered-output, 100,000 rendered-line/result,
context, diagnostic, or 120-second process ceilings.

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
| `XSearch` | **Grok-gated.** Live X/Twitter search via direct xAI when session provider is `grok` and `[providers.grok] x_search = true` |
| `web_fetch` | Fetch URL → text/markdown |

There is **no** separate LIVE tool named `web_search`; that string is only a
provider-native server-side tool id used internally by the Grok web-search
path. Model-facing search is `WebSearch` (plus gated `XSearch` when enabled).

### Planning / workflow

| Name | Notes |
| --- | --- |
| `TodoWrite` | Checklist / todo list |
| `EnterPlanMode` | Enter plan permission posture |
| `ExitPlanMode` | Exit plan mode (approval path) |
| `VerifyPlanExecution` | Compare plan vs progress summary |
| `WorkflowTool` | Bounded event-driven agent DAG runner; **deferred**. See [workflows.md](workflows.md) |
| `CronCreate` / `CronDelete` / `CronList` | Local scheduled prompts (`.agenc/scheduled_tasks.json`); **deferred**. Delivery-routed `webhook` URLs are public-egress only and address-pinned at fire time; see [autonomy.md](autonomy.md#cron-delivery-runtimesrcgatewaycron-deliveryts) |

### Interaction / user input

| Name | Notes |
| --- | --- |
| `AskUserQuestion` | Multi-choice questions (TUI picker); **visible by default** |
| `request_user_input` | Elicitation / free-form user input |
| `request_ledger_transfer` | Built-in typed Android/Ledger SOL transfer handoff; exact active root-turn `@ledger` authorization only |
| `ledger_wallet_cli_status` | Read-only Ledger Wallet CLI / device status |
| `install_ledger_wallet_cli` | Prompted install of the official wallet CLI under `AGENC_HOME` |
| `EditorProposal` | Editor-turn reviewable edit proposal (workbench BUFFER) |
| `SendUserMessage` | Short progress message to the user |
| `Sleep` | Sleep / yield; **deferred** by default |
| `Monitor` | Canonical unified-exec background process monitor; **deferred** by default |

### Worktree

| Name | Notes |
| --- | --- |
| `EnterWorktree` | **Deferred** by default |
| `ExitWorktree` | **Deferred** by default |

### Media (Grok-gated)

| Name | Notes |
| --- | --- |
| `ImagineImage` | Image generation via direct xAI when session provider is `grok` and credentials are available |
| `ImagineVideo` | Video generation via direct xAI when session provider is `grok` and credentials are available |

These are registered on the LIVE surface but only usable on the Grok/direct-xAI
path. Other providers do not advertise them as working media tools. Operator
guide: [imagine.md](../imagine.md).

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
Operator guide (SSRF, env, profile): [`../browser.md`](../browser.md).
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
| `Skill` | Invoke a skill by name (`skill` + optional `args`) |

### Task board / background tasks

| Name | Notes |
| --- | --- |
| `TaskCreate` | Durable project task board; **deferred**. `description` is optional and defaults to `subject` |
| `TaskGet` | Durable project task board; **deferred** |
| `TaskUpdate` | Durable project task board; **deferred** |
| `TaskList` | Durable project task board; **deferred** |
| `TaskOutput` | In-process background-task output; **deferred** |
| `TaskStop` | Stop in-process background task; **deferred** |

`TodoWrite` is the session checklist and is visible. LIVE Task* tools are always
registered but deferred. TUI pool board tools also need `AGENC_ENABLE_TASKS`
or an interactive session; that gate is **not** the LIVE catalog.

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
| `inspect_csv_agent_job` | Read a bounded summary and keyset-paginated item page |
| `read_csv_agent_job_result` | Read one bounded base64 result chunk |
| `list_csv_job_reviews` | Bounded page of unknown-outcome CSV reviews |
| `show_csv_job_review` | One bounded review record |
| `resolve_csv_job_review` | Approval-gated operator resolution with canonical evidence |

### MCP helpers (built-in) + bridge

| Name | Notes |
| --- | --- |
| `ListMcpResourcesTool` | List MCP resources (deferred) |
| `ReadMcpResourceTool` | Read MCP resource (deferred) |
| `mcp.<server>.<tool>` | Live tools from configured MCP servers (usually deferred until discovery) |

### Structured output / code-mode

| Name | Notes |
| --- | --- |
| `StructuredOutput` | Schema-bound when session has `outputSchema`; otherwise deferred passthrough |
| `exec` | Code-mode JS exec. Registered only when `AGENC_CODE_MODE` is `1`/`true`/`on` **and** `quickjs-emscripten` loads. Then advertised. Not deferred-discoverable when off. REPL is gone. |
| `wait` | Code-mode wait (same enablement as `exec`) |

### Default-visible vs deferred (high level)

Exact visibility is request-scoped and config-dependent. As coded in
`buildToolRegistry` defaults:

- **Typically advertised early:** `exec_command`, `write_stdin`, `kill_process`,
  `FileRead`, `Edit`, `MultiEdit`, `Write`, `Glob`, `Grep`, `Orient`,
  `AskUserQuestion`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode`,
  `system.searchTools`, plus non-deferred model-facing tools (web, multi-agent
  v2, Skill, CSV jobs, Imagine when registered). Task* / Cron* / `WorkflowTool`
  are **deferred**.
- **Deferred / discoverable examples:** `system.bash`, git/symbol `system.*`
  intel tools, MCP tools when `deferMcpTools` is on, MCP resource helpers,
  passthrough `StructuredOutput`, and other tools marked
  `metadata.deferred`.

Coordinator mode further **allowlists** orchestration tools only — see
[`agents.md`](agents.md).

---

## Local TUI and worker pool (`tools.ts`)

`runtime/src/tools.ts` exports the local tool pool used by permission presets,
AgentTool workers, and REPL primitives. `buildToolRegistry` remains the sole
authority for the model-facing catalog.

Notable differences (non-exhaustive):

| Topic | LIVE | TUI pool |
| --- | --- | --- |
| Shell | `exec_command` (+ deferred `system.bash`) | `CanonicalBashTool` (bash-shaped) |
| Files | `FileRead` / `Edit` / `Write` / `MultiEdit` / `apply_patch` | Canonical read/edit/write/notebook set |
| Multi-agent | `spawn_agent` family | Not assembled here (Team\* gated) |
| Discovery | `system.searchTools` + deferred system intel | Not provided by this pool |
| Code-mode | `exec` / `wait` when enabled | Not in pool |
| Authority | Model-facing catalog | Local TUI and worker consumers |

When docs or code comments say “registered tools”, assume LIVE unless they
explicitly cite `tools.ts`.

---

## Permission modes

Source of truth: `runtime/src/permissions/types.ts` (and
`runtime/src/types/permissions.ts`).

**Ordinary user-addressable modes** (`--permission-mode`, settings, slash
`/permissions`):

| Mode | Intent |
| --- | --- |
| `default` | Ask on sensitive / unmatched actions |
| `acceptEdits` | Auto-approve common edit-class actions; still gate higher risk |
| `plan` | Planning posture (plan banner in TUI); constrained execution |
| `dontAsk` | Deny rather than prompt when an ask would be required |
| `auto` | Classifier-assisted auto decisions |

`bypassPermissions` is restricted. It skips approval prompts down to the deny
floor, but it does not disable the OS sandbox. `/permissions mode
bypassPermissions` refuses the transition until the operator runs
`/permissions accept-bypass`. That confirmation is stored in permission-owned
runtime state for the exact canonical workspace path and directory identity.
It does not authorize another path or a replacement directory at the same
path. Managed policy can disable bypass mode entirely.

A live daemon client can carry the same consent on
`session.setPermissionMode` as `bypassAuthority: "operator_tool_approval"`
(the only accepted value). The field is still checked against the exact
canonical cwd; it is not a remote or cross-workspace waiver. Without it,
the RPC is refused with "requires explicit consent for this exact cwd"
unless stored accept-bypass consent already matches.

`--permission-mode bypassPermissions` is an explicit startup opt-in for the
current session and workspace; it does not write durable consent. The
`--dangerously-bypass-approvals-and-sandbox` flag is the separate combined
escape hatch for bypassed prompts and `danger-full-access`.

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
| Linux | Primary: system `bwrap` via the Node helper `agenc-linux-sandbox`. Fallback: `agenc-landlock-run` when the probe reports Landlock fully enforced. `engine/landlock.ts` only serializes helper flags; kernel Landlock is the C binary. |
| macOS | In-tree Seatbelt (`engine/seatbelt.ts`, `engine/policies/*.sbpl`) via `/usr/bin/sandbox-exec`. No AgenC native binary. |
| Windows | Restricted-token isolation is not implemented (`windows_restricted_token_unimplemented`). Restricted modes fail closed. Use WSL2, `external_sandbox`, or `--dangerously-bypass-approvals-and-sandbox` / `danger-full-access`. |

Native helpers:

| Binary | Source | Job |
| --- | --- | --- |
| `agenc-linux-sandbox` | `runtime/bin/agenc-linux-sandbox` → `dist/sandbox/linux-launcher/main.js` | Policy helper. Builds bwrap argv, or falls back to `agenc-landlock-run`. Must sit outside the writable workspace. Override path: `AGENC_LINUX_SANDBOX_EXE`. |
| `agenc-landlock-run` | `runtime/native/agenc-landlock-run.c` | Self-restrict then exec. `--ro` / `--rw` / `--probe` / `--seccomp <fd>`. Exit 125 on failure. Same seccomp network filter as bwrap. Cannot express deny-inside-allow (writable project with read-only `.git`). |
| `agenc-process-broker` | `runtime/native/agenc-process-broker.c` | Linux **lifecycle** subreaper (`PR_SET_CHILD_SUBREAPER`). Not filesystem isolation. Preferred tree-kill path is cgroup-v2; this is the fallback. |
| `agenc-process-job-broker.exe` | `runtime/native/agenc-process-job-broker.cs` | Windows **lifecycle** Job Object (`KILL_ON_JOB_CLOSE`). Not a restricted-token sandbox. |

`AGENC_DISABLE_LANDLOCK_FALLBACK=1` restores bwrap-or-die. `agenc doctor`
warns `[sandbox_landlock_fallback]` when Linux is ready only via Landlock.
`[sandbox].allow_gpu` is the macOS Metal opt-in ([config.md](config.md)).

### Home workspace vs helper containment

A userland install places `agenc-linux-sandbox` under
`$AGENC_HOME/runtime/<version>/…`. The helper must sit outside the writable
workspace (`resolveTrustedLinuxSandboxExecutable` in
`runtime/src/sandbox/execution-broker.ts`). A bare `agenc` in a fresh
terminal opens `$HOME` as the workspace, so the helper is inside that tree
and restricted startup fails closed:

```text
[sandbox_required_unavailable] required sandbox blocked startup: Linux sandbox
helper must be outside the writable workspace.
```

`linuxSandboxHelperRemediation` then names the cause. When the workspace is
the home directory, or an ancestor such as `/home` or `/`, the message says
so and tells the operator to open a project directory. When the helper is
misplaced inside an ordinary project, the original reinstall guidance stays
in force. `HOME` is used only when it is an absolute path; otherwise the
probe falls back to `os.homedir()`. Both sides are realpath'd, matching the
containment test they explain.

Do not carve `~/.agenc` out of a home workspace to make that layout work.
The Landlock fallback cannot express a read-only carve-out inside a writable
root, and home-as-workspace would also grant the agent write access to the
entire home directory.

### Linux launcher argv contract

`agenc-linux-sandbox` (`runtime/src/sandbox/linux-launcher/cli.ts`) fails
closed on handoff input that would widen or hide the boundary:

| Refusal | Why |
| --- | --- |
| Missing `--sandbox-policy-cwd` (unless `--inherited-readonly-command-cwd`) | Policy cwd is never inferred from the launcher's own working directory |
| Relative cwd or session-temp-root | Would re-anchor grants to the launcher cwd |
| Repeated value flags | A second `--command-cwd` would silently replace the first |
| A value that spells another `--flag` | Missing argument, not a path |
| Unknown argv or unknown profile JSON fields | Policies cannot smuggle unvalidated settings |
| `globScanMaxDepth` above `MAX_GLOB_SCAN_DEPTH` (128) | One glob must not become an unbounded filesystem walk |
| Project-root `subpath` that is absolute or escapes `..` | Grants stay inside the project root |
| NUL bytes in paths, profile strings, or command argv | Would truncate at an exec / C-string boundary |
| `--proxy-route-spec` without `--allow-network-for-proxy` | Network grant is explicit |
| `--inherited-readonly-command-cwd` plus explicit cwd or `--apply-seccomp-then-exec` | Inherited cwd is only valid for the outer launcher stage |

Production sessions never invoke this helper with operator-typed argv. The
contract matters when diagnosing a spawn refusal or writing a regression.

### Plugin MCP confinement

Stdio MCP uses the same sandbox broker as other child processes. On
Landlock-fallback hosts, workspace-write policies that need a writable project
with read-only `.git` or `.agenc` carve-outs fail in pre-flight with
`[sandbox_policy_unexpressible]`. Plugin-declared stdio servers substitute a
tighter profile: root read access and writes confined to the plugin data
directory. Landlock can express this profile, so plugin servers keep working
when bubblewrap is blocked.

Restricted-network seccomp allows `getsockname`, `getpeername`, and
`getsockopt`; Node's inherited pipe stdio therefore remains usable. See
[install.md](../install.md#ubuntu-apparmor-and-bubblewrap) and
[mcp.md](mcp.md#plugin-declared-servers).

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

`bypassPermissions` is an approval mode and does not by itself remove kernel
confinement. The CLI `--dangerously-bypass-approvals-and-sandbox` flag is the deliberate combined escape hatch: it
selects both bypassed prompts and `danger-full-access`. In `read-only` or
`workspace-write`, missing/unhealthy platform support, a failed behavioral
probe, a transform failure, or missing authenticated policy stops execution
before spawn. Inspect readiness and remediation with `agenc doctor`.

This invariant covers shell/unified-exec, Monitor, jobs, hooks/crons, stdio MCP,
daemon command exec, and the child-agent processes launched by workflows. The
design and stable error codes are documented in
[`../design/fail-closed-sandbox-execution.md`](../design/fail-closed-sandbox-execution.md).
Docker sandbox driver and SSH remote exec targets remain roadmap items
([`../roadmap.md`](../roadmap.md)).

### Troubleshooting

| Symptom | What to do |
| --- | --- |
| `[sandbox_required_unavailable]` + helper "outside the writable workspace" after a stock Linux install | The workspace is `$HOME` (or contains it). Open a project directory. Do not reinstall. |
| `[sandbox_landlock_fallback]` from `agenc doctor` | Bubblewrap is unusable; Linux is ready only via Landlock. On Ubuntu 24.04+ install the AppArmor profile in [install.md](../install.md). Otherwise restore `bwrap` or accept the fallback limits. |
| `[sandbox_policy_unexpressible]` on shell or workspace-write stdio MCP | Landlock cannot keep `.git` / `.agenc` read-only inside a writable project. Restore bubblewrap, use `sandbox_mode = "read-only"`, or choose `danger-full-access`. Plugin-declared MCP servers keep a tighter, Landlock-expressible profile. |
| Windows restricted-mode spawn refused | Native restricted-token isolation is unimplemented. Use WSL2, `external_sandbox`, or the deliberate danger-mode escape hatch. |

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

Model and charged-tool boundaries traverse the daemon execution-admission
kernel — see [`autonomy.md`](autonomy.md) and
[`../design/execution-admission-kernel.md`](../design/execution-admission-kernel.md).
Budget is orthogonal to permission modes: a turn can be permission-approved
and still be denied before dispatch.

## Multi-agent tools

See [`agents.md`](agents.md) for `spawn_agent` / `wait_agent` / `close_agent` /
`assign_task` / `send_message` / `list_agents`.

## Related CLI / TUI

- `/permissions`, `/mcp`, `/hooks`, `/skills`, `/plugins`, `/agents`
- `agenc doctor` — includes transaction-guard status
- `agenc security audit` — exposure / posture checks
