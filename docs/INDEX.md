# AgenC documentation index

Canonical map of docs under `docs/`. Product overview and install entry:
[`../README.md`](../README.md). Contributor loop: [`../AGENTS.md`](../AGENTS.md).

Version in tree: **runtime / launcher 0.3.0** (pre-release); embedding SDK
**0.2.0**. Default provider **grok**, default model **grok-4.3**.

Layout follows a Diataxis-ish split: tutorials (start here), how-to, reference,
explanation. Prefer linked pages over archive notes when they disagree.

---

## Tutorials

| Doc | Summary |
| --- | --- |
| [quickstart.md](quickstart.md) | Install → onboard → first chat in minutes |
| [install.md](install.md) | Installer, npm, Docker, Windows, update path |
| [onboarding.md](onboarding.md) | First-run wizard + acts (identity, channel, autonomy, recap) |

## How-to

| Doc | Summary |
| --- | --- |
| [gateway.md](gateway.md) | Channel gateway: Telegram, Discord, Slack, WebChat, stdio; pairing; heartbeat/hooks |
| [remote-control.md](remote-control.md) | Pair host with AgenC phone app (`agenc remote`) |
| [managed-openrouter.md](managed-openrouter.md) | Hosted OpenRouter / managed keys via remote auth |
| [deploy/vps.md](deploy/vps.md) | Run the daemon on a VPS (installer or Docker) |
| [migrate-from-openclaw.md](migrate-from-openclaw.md) | Surface map from OpenClaw |
| [migrate-from-hermes.md](migrate-from-hermes.md) | Surface map from Hermes Agent |
| [trajectory-training-data.md](trajectory-training-data.md) | Enable trajectory export and curate SFT/DPO JSONL |
| [agent-eval-reports.md](agent-eval-reports.md) | Local agent-eval suite, reports, and regression gate |
| [provider-tool-compat.md](provider-tool-compat.md) | Tool JSON-schema root-type requirements for strict providers |
| [embedded-neovim-buffer.md](embedded-neovim-buffer.md) | BUFFER providers, nvim trust boundary, env knobs |
| [sdk.md](sdk.md) | Embed via `@tetsuo-ai/agenc-sdk` (socket + subprocess) |
| [security/slm-transaction-guard.md](security/slm-transaction-guard.md) | Opt-in SLM CourtGuard for Solana-like tool calls |

## Reference

| Doc | Summary |
| --- | --- |
| [reference/cli.md](reference/cli.md) | Full CLI: top-level flags, all subcommands |
| [reference/daemon.md](reference/daemon.md) | Daemon process model, socket auth, lifecycle |
| [reference/providers.md](reference/providers.md) | Built-in providers, defaults, API key envs |
| [reference/autonomy.md](reference/autonomy.md) | Budget + heartbeat + cron delivery + hooks |
| [reference/agents.md](reference/agents.md) | Background agents + multi-agent v2 tools |
| [reference/mcp.md](reference/mcp.md) | MCP client and server |
| [reference/tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) | Tools catalog, permission modes, OS sandbox |
| [reference/tui-workbench.md](reference/tui-workbench.md) | TUI shell, workbench, BUFFER summary |

## Explanation

| Doc | Summary |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process model, subsystem map, on-disk state |
| [design/budget-enforcement.md](design/budget-enforcement.md) | Why/how cost-bounded autonomy is enforced |
| [roadmap.md](roadmap.md) | Shipped vs open backlog (current product truth) |

---

## Archive (historical only)

[`archive/`](archive/) is **not product truth**. Do not use it to decide what is
shipped. See [`archive/README.md`](archive/README.md).

| File | Note |
| --- | --- |
| [archive/codebase-quality-audit.md](archive/codebase-quality-audit.md) | Closed provenance log |
| [archive/feature-user-stories.csv](archive/feature-user-stories.csv) | Orphan inventory snapshot |
| [archive/onboarding-plan-2026-07.md](archive/onboarding-plan-2026-07.md) | Superseded by [onboarding.md](onboarding.md) |
| [archive/parity-roadmap-2026-07.md](archive/parity-roadmap-2026-07.md) | Superseded by [roadmap.md](roadmap.md) |

---

## Outside `docs/` (still useful)

| Path | Summary |
| --- | --- |
| [`../README.md`](../README.md) | Product README (0.3.0) |
| [`../AGENTS.md`](../AGENTS.md) | Contributor / agent working rules |
| [`../TODO.md`](../TODO.md) | Active engineering backlog for assistants |
| [`../packages/agenc-sdk/README.md`](../packages/agenc-sdk/README.md) | SDK package readme |
| [`../runtime/eval/README.md`](../runtime/eval/README.md) | Agent-eval harness notes |
| [`../runtime/src/tui/README.md`](../runtime/src/tui/README.md) | TUI architecture (Ink fork, themes) |
| [`../runtime/src/mcp-client/README.md`](../runtime/src/mcp-client/README.md) | Outbound MCP client notes |
| [`../runtime/src/agents/v2/PARITY.md`](../runtime/src/agents/v2/PARITY.md) | Multi-agent v2 tool parity |
| [`../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md`](../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md) | Web-search provider config |
| [`../parity/agent-surface-contract.reviews/README.md`](../parity/agent-surface-contract.reviews/README.md) | Agent-surface contract reviews |
| [`../parity/embedded-neovim-buffer.reviews/README.md`](../parity/embedded-neovim-buffer.reviews/README.md) | Embedded-Neovim contract reviews |
