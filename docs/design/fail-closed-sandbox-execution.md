# Fail-closed process execution

Status: implemented. Threat model and primary-source research refreshed
2026-07-16.

## Decision

AgenC has one authenticated process-execution boundary. A restricted policy
(`workspace-write` or `read-only`) has only two outcomes:

1. a behavioral platform probe succeeds and the final program/argv is
   transformed through the platform sandbox; or
2. execution stops before the host process is spawned.

There is no warning-only fallback. Raw host execution is permitted only when a
trusted operator explicitly selected `danger-full-access`/`--yolo`, or when an
explicit external sandbox policy says isolation is owned outside AgenC.
Repository content and model-supplied arguments cannot create either decision.

The authenticated broker is created from resolved session policy before MCP,
hook, provider, or model-tool startup. It is carried as non-enumerable runtime
metadata through tool compatibility adapters, so JSON/model input cannot spoof
it. Long-lived boundaries rebase with an interactive worktree transition;
child sessions fork an independent boundary rooted at their execution cwd,
while role authority remains anchored to its canonical workspace.

## Covered process surfaces

Every process reachable from a model turn, repository-controlled content, or a
session-owned automation path must cross the broker at its final spawn point:

| Class | Covered paths | Restricted-mode behavior |
| --- | --- | --- |
| Turns and commands | interactive, print, foreground/background shell, Monitor, workflow, job, hook, cron | Transform the final program/argv or reject before spawn. Job and cron are durable origins; their eventual turn/tool process uses the same boundary. |
| Extensions and daemon RPC | stdio MCP, daemon `commandExec` | Require an explicit authenticated policy. Missing policy is not inferred from request fields. |
| Coding helpers | Git/repository inspection, code indexing, worktree lifecycle, prompt Git lookup, Grep/Glob/Orient, PDF extraction | PATH-resolved probes and the actual helper both use the boundary; a pure-JavaScript fallback is allowed only where it does not start a process. |
| Language and provider services | LSP, Chromium, PowerShell native parsing, xAI ACP | Each child uses the owning session's broker. Long-lived services own detached process trees and do not report disposal complete until their descendants are gone. LSP manager/config state is keyed by broker identity, so a restricted session cannot reuse a later danger-mode session's server. |
| Collaboration | child-agent tools and worktrees, pane teammates | Child sessions fork independent provider, MCP, browser, and execution-lifecycle ownership rooted at the child cwd. A compatibility provider that cannot fork loses MCP-origin tools and receives an inert child MCP manager instead of sharing the parent's authority. Restricted `auto` teammate mode selects the in-process backend; an explicitly requested pane backend fails closed because it is outside the session sandbox. |

Production daemon/background-agent bootstrap asserts required sandbox readiness
before extension or provider startup. Interactive sessions may still open so an
operator can run `agenc doctor`, but the first covered execution fails with the
same stable diagnostic if readiness is absent.

Raw subprocesses that are not reachable from a session or repository content,
such as packaging/build utilities and explicit operator service management,
remain control-plane processes. That classification is not a reusable bypass:
making one reachable from a model/session requires moving it behind the broker
and adding a boundary regression test.

## Platform readiness

- Linux requires the packaged `agenc-linux-sandbox` helper outside the writable
  workspace and a trusted system `bubblewrap`. Readiness executes a bounded
  namespace probe; finding binaries on disk is insufficient. The helper is
  resolved through the installed runtime package root so source and bundled
  layouts agree. It is launched through the absolute trusted Node executable,
  and runtime/native-loader injection variables are removed before the first
  pre-sandbox process. A command profile that could write either launcher is
  rejected.
- macOS requires `/usr/bin/sandbox-exec` and a bounded restricted-process probe.
- Native Windows restricted-token isolation is not implemented, so restricted
  execution fails closed. Operators can use WSL2, an explicit external sandbox,
  or deliberately select danger-full-access.

Probe results are cached per session. Daemon `commandExec` applies the same
behavioral probe before transform/spawn. A successful probe does not weaken the
spawn boundary: transform failure, helper disappearance, or an unsupported
surface still stops execution. Child exit caused by a sandbox launcher failure
is reported as a failed command and never retried as an unsandboxed command.

## Capability and secret minimization

The sandbox profile is least-privilege per spawn, not merely per session:

- Child environments are copied through the common secret scrubber. Provider,
  cloud, GitHub, signing, and other credential-shaped variables are not passed
  to Git, search, PDF, browser, PowerShell, prompt, worktree, or code-intel
  helpers.
- The xAI ACP child receives only the credential it consumes (`XAI_API_KEY`),
  its public attribution value, and an explicit network grant. Other provider
  and repository credentials remain removed. Chromium's existing network grant
  likewise applies only to the browser child.
- Restricted Git worktree mutations receive operation-scoped write grants for
  canonical Git metadata and the exact worktree parent/target needed by that
  operation. Creation is split into `worktree add --no-checkout` and a second,
  narrower checkout that can write the linked worktree's administrative
  directory but not the repository's common `.git` directory. The privileged
  Git invocation disables repository hooks and file system monitor hooks with
  per-command configuration. Ordinary sandboxed commands still cannot write
  `.git`, `.agenc`, or `.agents` metadata.
- Bounded helper collection sends `SIGTERM` and then escalates to `SIGKILL` for
  the complete spawned process group. The same verified process-tree shutdown
  primitive owns LSP, Chromium, stdio MCP, and ACP children. This prevents a
  signal-trapping child or inherited stdio in a descendant from leaving the
  tool promise pending or surviving a completed session teardown.
- Stdio MCP resolves relative server working directories against the owning
  broker rather than daemon-global cwd, bounds newline-delimited JSON frames at
  16 MiB (matching the server-side envelope limit), and cancels stale
  start/reconnect generations. Session disposal is strict: it waits for active
  connection/reconnect cleanup, and synchronous or asynchronous transport
  shutdown failures remain observable.

Credentialed Git/network operations that depended on inheriting ambient daemon
secrets now fail rather than receiving those secrets implicitly. A future
credential flow must be explicit, scoped to the operation and host, auditable,
and independently approved; broad environment restoration is not compatible
with this boundary.

## Diagnostics and stable failures

`agenc doctor` reports the selected mode, platform, readiness state, precise
reason, and remediation. Tool/startup paths preserve the same reason. Automation
can classify:

- `sandbox_required_unavailable` — required platform support/helper is absent;
- `sandbox_probe_failed` — installed support cannot create isolation;
- `sandbox_transform_failed` — the final command could not be wrapped; and
- `sandbox_surface_uncovered` — an execution path arrived without authenticated
  policy/broker state.

These errors happen before spawn. Explicit danger/external modes remain visible
policy selections rather than recovery behavior.

## Compatibility, operations, and rollback

This intentionally breaks callers that used daemon `commandExec.start` without
`permissionProfile` or `sandboxPolicy`, embedders that launched stdio MCP or
command hooks outside a session, pane-based teammates under restricted policy,
and helper processes that implicitly consumed ambient secrets. They must supply
an explicit policy boundary; `danger-full-access` preserves intentional host
execution but does not restore secret inheritance.

The change does not alter persisted session or workflow formats. Rollback is a
single focused revert, but doing so reopens host-execution bypasses. Operational
recovery is to repair the reported platform dependency, run `agenc doctor`, and
retry the command. Do not recover by silently changing policy.

## Verification contract

Revert-sensitive tests use marker-writing commands and assert that the marker is
never created when the broker is missing, the probe fails, or transformation
fails. Tests cross real tool/transport boundaries for interactive, print,
background, Monitor, workflow, hook, MCP stdio, daemon command execution,
coding helpers, worktrees, browser, LSP, ACP, PowerShell parsing, and teammate
selection; surface-matrix tests cover cron/job/child-agent classifications.

Healthy-path tests also prove that transformed program/argv/cwd/env/argv0 values
are honored, restricted worktree creation uses separate add/checkout grants and
the checkout cannot write common Git metadata, unrelated secrets are absent in
the actual child, ACP retains its one required credential and network
permission, provider recreation retains the same broker, child sessions cannot
reuse parent MCP/browser/provider ownership, concurrent LSP sessions cannot
substitute managers, oversized MCP frames fail closed, start/dispose races do
not resurrect transports, a failed browser launch transfers its exact child
ownership into a poisoned manager until explicit cleanup succeeds, and a
TERM-resistant descendant is force-killed within the bounded grace period.
Built-layout resolution, explicit danger/external pass-through, doctor output,
and restricted daemon transforms remain separate contracts.

## Alternatives rejected

- Warning and execute on the host: violates the declared policy and makes a
  security failure indistinguishable from success.
- Presence-only binary checks: cannot detect disabled user namespaces, broken
  launchers, or policy/runtime mismatch.
- Independent checks at each tool: inevitably drift and lose context through
  compatibility adapters.
- Approval text or command scanning as isolation: approval authorizes intent;
  it is not an operating-system boundary.
- Automatic danger mode on unsupported platforms: turns environmental failure
  into silent privilege escalation.

## Research record

Primary and upstream sources reviewed 2026-07-16:

- [OpenAI agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
  and [sandboxing](https://learn.chatgpt.com/docs/sandboxing) describe explicit
  approval/isolation boundaries and platform behavior.
- [OpenAI Linux sandbox implementation](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md) <!-- branding-scan: allow upstream sandbox research citation -->
  informed the separation between policy decisions and final OS enforcement.
- [Linux Landlock](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html),
  [`no_new_privs`](https://docs.kernel.org/userspace-api/no_new_privs.html), and
  [seccomp filters](https://docs.kernel.org/userspace-api/seccomp_filter.html)
  document the kernel primitives and their limits.
- [Bubblewrap](https://github.com/containers/bubblewrap) and its
  [v0.11.2 release](https://github.com/containers/bubblewrap/releases/tag/v0.11.2)
  informed trusted-path and behavioral namespace probing.
- [Apple App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
  and [Xcode sandbox configuration](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
  establish the macOS isolation model.
- [Windows sandboxed process creation](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox),
  [AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer),
  [job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
  and [`taskkill /T`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
  show why process lifecycle control alone is not a complete restricted-token
  implementation. Where AgenC owns a Windows child tree today, it awaits the
  documented tree termination command and treats an unverifiable result as a
  teardown failure rather than inferring success from leader exit.
- [Git configuration](https://git-scm.com/docs/git-config) documents the
  per-command `core.hooksPath=/dev/null` hook disablement and the executable
  `core.fsmonitor` hook surface used to harden metadata-privileged worktree
  operations.
- [Git attributes](https://git-scm.com/docs/gitattributes) documents that
  checkout can invoke configured smudge and long-running process filters. This
  is why checkout receives a separate grant that excludes common Git metadata.
- [Node.js child-process lifecycle](https://nodejs.org/api/child_process.html)
  documents detached POSIX process groups, trappable `SIGTERM`, and that
  killing a parent does not terminate its descendants on Linux; this is why
  long-lived service teardown uses verified process-group termination and
  forced escalation.
- [Model Context Protocol transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  specifies a spawned stdio server and newline-delimited JSON-RPC messages on
  stdout. The transport therefore enforces an explicit frame bound before
  parsing and owns the complete server process tree.
- [Agent Client Protocol session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
  requires session-specific working-directory context and explicitly models
  stdio child environment, supporting a session-owned ACP spawn boundary rather
  than a process-global one.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) <!-- branding-scan: allow current competitor sandbox research -->,
  [Hermes security guidance](https://hermes-agent.nousresearch.com/docs/user-guide/security) <!-- branding-scan: allow comparator research citation -->,
  and [OpenClaw sandboxing](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md) <!-- branding-scan: allow comparator research citation -->
  were checked for current peer behavior. Their layered isolation and explicit
  escape modes support a common boundary; none justifies warning-only fallback.
