# Slash commands reference

User-invocable TUI / daemon slash palette. Registry:
`runtime/src/commands/registry.ts` (`buildDefaultRegistry`). Unlisted commands
are not dispatchable through that registry.

Parse/dispatch: `runtime/src/commands/dispatcher.ts` (`/name args`).

**Provider command is `/provider`**, not `/model-provider`. Config key remains
`model_provider` / env `AGENC_PROVIDER`.

---

## Registered commands

Order matches `buildDefaultRegistry`.

| Command | Aliases | Purpose |
| --- | --- | --- |
| `/help` | | Show help and available commands |
| `/status` | | Show current session and runtime status |
| `/login` | | Sign in with your AgenC account |
| `/logout` | | Sign out of your AgenC account |
| `/whoami` | `account` | Show the signed-in AgenC account |
| `/subscription` | `billing` | Show your AgenC plan and billing URL |
| `/usage` | | Show hosted model usage for your AgenC plan |
| `/grok-login` | `xai-login` | Sign in with X for Grok subscription access (optional `device` flow) |
| `/grok-logout` | `xai-logout` | Sign out of the xAI / Grok OAuth session |
| `/cost` | `stats` | Show session cost, token usage, and per-agent spend |
| `/model` | | Switch the model (picker or pass a name) |
| `/provider` | | Switch the LLM provider for subsequent turns |
| `/permissions` | `approvals`, `allowed-tools` | Manage permission mode and rules |
| `/plan` | | Enter plan mode or display the current plan (read-only tools) |
| `/agents` | | Manage agents — opens a picker |
| `/tasks` | `jobs`, `bashes` | Show live background tasks and spawned agents |
| `/todos` | `todo` | Show the session todo lists |
| `/config` | `settings` | Manage configuration — opens a picker |
| `/hooks` | | Inspect and test AgenC hook configuration |
| `/skills` | | Manage project skills and show loaded skill roots |
| `/mcp` | | Show and manage MCP servers |
| `/remote` | | Link this machine to the AgenC phone app |
| `/plugins` | `plugin`, `marketplace` | Show and manage AgenC plugins |
| `/memory` | | Open AgenC memory editor (TUI; headless points at TUI) |
| `/resume` | `sessions` | List resumable sessions for this project |
| `/rewind` | | Restore the code and/or conversation to a previous point |
| `/init` | | Analyze this repository and write `.agenc/config.json` plus `AGENC.md` |
| `/output-style` | `style` | Switch the active output style |
| `/output-style:new` | | Ask the agent to author a new project output style |
| `/clear` | `reset`, `new` | Clear session history and caches |
| `/compact` | | Compact the current conversation |
| `/context` | `ctx` | Show current context usage |
| `/coordinator` | `fleet` | Show or toggle coordinator (orchestrator) mode |
| `/diff` | | Show uncommitted changes (`git diff HEAD` + untracked) |
| `/claim` | | Protocol: claim an open marketplace task (gated by `[protocol]`) |
| `/delegate` | | Protocol: delegate a task step (owner-gated; often stub) |
| `/proof` | | Protocol: generate or verify a proof (owner-gated; often stub) |
| `/settle` | | Protocol: submit completion / settle escrow (owner-gated) |
| `/stake` | | Protocol: inspect or adjust protocol stake (owner-gated) |
| `/exit` | `quit` | Shut down the session cleanly and exit |

Sources: `runtime/src/commands/*.ts(x)` modules imported by the registry
(`help`, `status`, `auth`, `xai-auth`, `cost`, `model`, `provider`,
`permissions`, `plan`, `agent-management`, `tasks`, `todos`, `config`, `hooks`,
`skills`, `mcp`, `remote`, `plugins`, `memory/slash`, `resume`, `rewind`, `init`,
`output-style`, `clear`, `session-compact`, `coordinator`, `diff`, `protocol`,
`exit`). Related how-to: [grok-oauth.md](../grok-oauth.md).

---

## Notes

| Topic | Fact |
| --- | --- |
| Surfaces | Some commands declare `supportedSurfaces` (e.g. `/hooks` → `runtime`, `daemon-tui`); default is all surfaces when omitted |
| Protocol verbs | Default: honest stub unless `[protocol] enabled = true` + `adapter = "marketplace-cli"`; mutating verbs stay owner-gated |
| `/provider` vs config | Slash name `/provider`; persisted field `model_provider` |
| Help groups | Presentation metadata in `runtime/src/commands/help-groups.ts` |
| Plugin-added commands | Plugins can register additional commands outside this minimal registry (see [skills-plugins.md](skills-plugins.md)) |

Related: [cli.md](cli.md) (top-level `agenc` subcommands), [tui-workbench.md](tui-workbench.md).
