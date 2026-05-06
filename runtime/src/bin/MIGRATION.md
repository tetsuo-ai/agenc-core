# Runtime Bin Migration

`runtime/src/bin/` currently mixes CLI entry wrappers with local runtime
bootstrap helpers. During the daemon rollout, each production `.ts` file under
this directory is classified so future moves are deliberate.

Side labels:

- `client-only`: safe to keep on the CLI side. These files parse user-facing
  commands, route terminal startup, or render command output. They may call a
  daemon client, but they are not daemon runtime code.
- `daemon-only`: belongs only in the daemon process. There are no current
  production `.ts` files in this directory with that classification.
- `shared`: used by both the direct CLI fallback and daemon/background-agent
  execution paths, or owns model-facing runtime helpers that both sides need
  until they are moved to a neutral runtime directory.

## Inventory

| File | Side | Reason |
| --- | --- | --- |
| `runtime/src/bin/_deps/commands.ts` | client-only | Per-directory slash-command bridge used by the local CLI/TUI slash path. |
| `runtime/src/bin/_deps/current-session.ts` | shared | Process-global current-session slot consumed by `bootstrapLocalRuntimeSession`, which is used by direct and daemon-launched sessions. |
| `runtime/src/bin/_deps/env-utils.ts` | shared | Config-home resolver consumed by the shared bootstrap path. |
| `runtime/src/bin/_deps/session-ingress-auth.ts` | shared | Session-ingress auth hook consumed by bootstrap when optional session ingress is configured. |
| `runtime/src/bin/_deps/session-storage.ts` | shared | Transcript loader and session-ingress setters consumed by shared bootstrap rehydration. |
| `runtime/src/bin/_deps/tools-types.ts` | shared | Tool shape and stringify helper used by `delegate-tool.ts`, which is shared by direct and background-agent sessions. |
| `runtime/src/bin/_deps/types-logs.ts` | shared | Transcript collapse entry types consumed by the shared session-storage helper. |
| `runtime/src/bin/agenc.ts` | client-only | Top-level executable, command dispatcher, TUI launcher, and direct-runtime fallback owner. It calls daemon helpers but is not daemon runtime code. |
| `runtime/src/bin/auth-cli.ts` | client-only | Implements `agenc login`, `logout`, and `whoami` terminal commands over the configured auth backend. |
| `runtime/src/bin/bootstrap-services.ts` | shared | Builds session services used by `bootstrapLocalRuntimeSession`, which serves both direct CLI/TUI startup and background-agent runner startup. |
| `runtime/src/bin/bootstrap-tool-registry.ts` | shared | Builds the tool registry for `bootstrapLocalRuntimeSession`; it feeds both direct CLI sessions and daemon-launched sessions. |
| `runtime/src/bin/bootstrap.ts` | shared | Owns `bootstrapLocalRuntimeSession`; imported by the CLI fallback and by the background-agent runner. |
| `runtime/src/bin/delegate-tool.ts` | shared | Binds `system.agent.delegate` control state for regular sessions and background-agent sessions. |
| `runtime/src/bin/mcp-cli.ts` | client-only | Parses and runs the user-facing `agenc mcp serve` command; server internals live under `runtime/src/mcp-server/`. |
| `runtime/src/bin/model-facing-tools.ts` | shared | Assembles built-in model-facing tools for any runtime session, regardless of whether it starts from the CLI fallback or daemon path. |
| `runtime/src/bin/providers-cli.ts` | client-only | Implements the user-facing `agenc providers` availability command and terminal output. |
| `runtime/src/bin/resume-session.ts` | client-only | Resolves TUI resume targets from project-local session files for CLI startup routing. |
| `runtime/src/bin/route.ts` | shared | CLI/TUI routing table plus startup flag helpers imported by `startup-selection.ts`, which is used by shared session bootstrap. |
| `runtime/src/bin/slash.ts` | client-only | Local slash-command dispatcher used by the CLI/TUI path; bridge-safety checks are routing policy, not daemon runtime. |
| `runtime/src/bin/startup-selection.ts` | shared | Resolves provider/model/profile startup selection for `bootstrapLocalRuntimeSession`, which is reused by direct and daemon-launched sessions. |
| `runtime/src/bin/state-cli.ts` | client-only | Implements `agenc state export` and `agenc state import` terminal commands. |
| `runtime/src/bin/structured-output-tool.ts` | shared | Provides the model-facing structured-output tool used by runtime sessions from either side. |
| `runtime/src/bin/task-store.ts` | shared | Provides durable task-board storage used by model-facing task tools in runtime sessions. |
| `runtime/src/bin/web-fetch-preapproved.ts` | shared | Supplies the WebFetch preapproved-host lookup used by model-facing web tools. |
| `runtime/src/bin/workflow-controller.ts` | shared | Bridges plan-mode tool state into a live session; used through the shared bootstrap tool registry. |

## Enforcement

`scripts/check-bin-classification.mjs` verifies that every non-test `.ts` file
under `runtime/src/bin/` appears exactly once in the inventory above with a
valid side label. Update this file in the same change that adds, moves, or
deletes production files in `runtime/src/bin/`.
