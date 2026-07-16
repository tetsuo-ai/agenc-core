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

The authenticated broker is created from resolved session policy before MCP or
hook startup. It is carried as non-enumerable runtime metadata through tool
compatibility adapters, so JSON/model input cannot spoof it. The final boundary
covers interactive and print-mode shells, foreground/background commands,
workflow commands, monitored jobs, configured and legacy hooks, cron-triggered
turns, stdio MCP servers, daemon `commandExec`, and child-agent tool execution.
Long-lived boundaries rebase with an interactive worktree transition; child
sessions fork an independent boundary rooted at their execution cwd, while role
authority remains anchored to its canonical workspace.

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
`permissionProfile` or `sandboxPolicy`, and embedders that launched stdio MCP or
command hooks outside a session. They must supply an explicit policy boundary;
`:danger-full-access` preserves intentional host execution.

The change does not alter persisted session or workflow formats. Rollback is a
single focused revert, but doing so reopens host-execution bypasses. Operational
recovery is to repair the reported platform dependency, run `agenc doctor`, and
retry the command. Do not recover by silently changing policy.

## Verification contract

Revert-sensitive tests use marker-writing commands and assert that the marker is
never created when the broker is missing, the probe fails, or transformation
fails. Tests cross real tool/transport boundaries for interactive, print,
background, Monitor, workflow, hook, MCP stdio, and daemon command execution;
surface-matrix tests cover cron/job/child-agent classifications. Built-layout
resolution, explicit danger/external pass-through, doctor output, and restricted
daemon transforms are separate contracts.

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
  and [job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
  show why process lifecycle control alone is not a complete restricted-token
  implementation.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) <!-- branding-scan: allow current competitor sandbox research -->,
  [Hermes security guidance](https://hermes-agent.nousresearch.com/docs/user-guide/security) <!-- branding-scan: allow comparator research citation -->,
  and [OpenClaw sandboxing](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md) <!-- branding-scan: allow comparator research citation -->
  were checked for current peer behavior. Their layered isolation and explicit
  escape modes support a common boundary; none justifies warning-only fallback.
