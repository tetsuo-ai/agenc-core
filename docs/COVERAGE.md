# Documentation coverage checklist

Contributor map of product surfaces vs docs. Not a user guide.
Canonical user map: [INDEX.md](INDEX.md).

This campaign (2026-08-23) deleted unpublished release notes and two dated
incident dumps, added `env.md` and `imagine.md`, and aligned slash, daemon
internal RPCs, LIVE tools, CLI, config defaults, install honesty, and
critical-path status with the 0.17.0 tree.

## Done this pass

| Surface | Doc |
| --- | --- |
| Canonical home/provider/runtime-option env contract; removed aliases | [env.md](reference/env.md), [config.md](reference/config.md), [cli.md](reference/cli.md) |
| Strict config v2 layering, provenance, migration/rollback, native-vault namespace disposition, state/trust/credential split | [config.md](reference/config.md), [cli.md](reference/cli.md), [ARCHITECTURE.md](ARCHITECTURE.md) |
| TUI watchdog, BUFFER chords, workbench panes | [tui-workbench.md](reference/tui-workbench.md) |
| README/roadmap effort default, Landlock, Homebrew, INDEX links | [README.md](../README.md), [roadmap.md](roadmap.md) |
| Shipped zeroday-hunter vs plugins.enabled | [skills-plugins.md](reference/skills-plugins.md) |
| Task/Cron/Workflow deferred + code-mode enablement | [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) |
| Memory/skills/plugins load paths + output styles | [memory.md](reference/memory.md), [skills-plugins.md](reference/skills-plugins.md) |
| Heartbeat/budget/hooks HTTP vs session hooks | [autonomy.md](reference/autonomy.md), [hooks.md](reference/hooks.md), [gateway.md](gateway.md) |
| Journal recovery CLI (quarantine vs deferred, rescan vs repair) | [cli.md](reference/cli.md), [ARCHITECTURE.md](ARCHITECTURE.md) |
| LLM retry/idle/OAuth/token-fallback v2 | [providers.md](reference/providers.md), [grok-oauth.md](grok-oauth.md) |
| Gateway pairing/approvals/media truth + remote off | [gateway.md](gateway.md), [remote-control.md](remote-control.md) |
| Entrypoint Wave 5-B labels stripped; config/init CLI headers | `runtime/src/bin/{route,agenc-main,config-cli,init-cli}.ts` |
| SDK JSDoc on client/session/protocol version (not every protocol type) | `packages/agenc-sdk/src`, `runtime/src/app-server/protocol/index.ts` |
| SDK 1.2 events, error classes, CSV helpers, path resolvers | [sdk.md](sdk.md), `packages/agenc-sdk` |
| Public daemon notifications (17 names, including `event.event_gap`) | [reference/daemon.md](reference/daemon.md), [sdk.md](sdk.md) |
| Historical dumps / unpublished tags | Removed from tree (Git history keeps them) |
| Slash registry vs table | [reference/slash-commands.md](reference/slash-commands.md) |
| Public + internal daemon methods | [reference/daemon.md](reference/daemon.md) |
| Autostart 3-cycle cap | [reference/daemon.md](reference/daemon.md) |
| Operator env vars | [reference/env.md](reference/env.md) |
| Imagine tools | [imagine.md](imagine.md) |
| Config buffer / autoFix / watchdog default | [reference/config.md](reference/config.md) |
| Missing LIVE tools (Ledger CLI, EditorProposal, CSV review) | [reference/tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) |
| Native sandbox binaries, Landlock vs bwrap, lifecycle brokers | [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) |
| SDK errors | [sdk.md](sdk.md) |
| Output styles load paths | [reference/skills-plugins.md](reference/skills-plugins.md) |
| CP-0001..0008 runtime status | [design/critical-path/README.md](design/critical-path/README.md) |
| Homebrew / GHCR honesty | [install.md](install.md) |
| Mailbox E3b | [design/mailbox-metadata-contract.md](design/mailbox-metadata-contract.md) |

## Still open (next pass)

| Gap | Where |
| --- | --- |
| Split user install vs release runbook (skill still points at install.md) | `docs/install.md` lines ~311-1250 |
| Split ~900-line inactive App/host/ruleset design out of ci-required-gates.md | `docs/ci-required-gates.md` (live hosted inventory was corrected this pass) |
| Top-level `formatCliHelpText()` still omits doctor/remote/full gateway/state recovery | `runtime/src/bin/agenc-main.ts` (code) and [cli.md](reference/cli.md) |
| Default-route flags `--debug`, `--init-only`, `--sdk-url`, `--agent-teams` | [cli.md](reference/cli.md) |
| `plugin update --scope`, marketplace `--force` | [cli.md](reference/cli.md) |
| Onboarding wizard omits mistral / nvidia-nim / minimax / github / amazon-bedrock | [onboarding.md](onboarding.md) |
| Heap watchdog / `$AGENC_HOME/oom-snapshots` | [daemon.md](reference/daemon.md) |
| Move shipped design pages into reference (keep unique MUST/MUST NOT) | `docs/design/` |
| `release:run` still target | [design/release-controller.md](design/release-controller.md) |
| CP-0008 fork `taskPrompt` concatenation | code, not docs |
| Mailbox E3b + WorkflowTool vs M5 vs CSV | [agents.md](reference/agents.md), [workflows.md](reference/workflows.md) |
| Eval trust suite 7/7 + executor commands | [evaluation-suites-v1.md](evaluation-suites-v1.md), [eval/real-agent-baseline-runbook.md](eval/real-agent-baseline-runbook.md) |
| Eval-executor evidence-ledger binding | [design/eval-pilot-executor.md](design/eval-pilot-executor.md) |

## Verify commands

After further doc edits:

```bash
# no live links to deleted files
rg 'unpublished bootstrap-identity|source-tag-only 0.7' docs/INDEX.md

# slash names in registry vs table
# CLI dispatch cases vs cli.md headings
# KNOWN_CONFIG_KEYS vs config.md
# AGENC_DAEMON_METHODS vs daemon.md / sdk.md
```
