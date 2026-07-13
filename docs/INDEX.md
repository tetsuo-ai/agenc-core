# AgenC documentation index

Canonical map of docs under `docs/`. Product overview and install entry:
[`../README.md`](../README.md).

Version in tree: **runtime / launcher 0.6.0**; embedding SDK
**0.2.0**. Default provider **grok**; fresh-config session model **grok-4.5**
(same as provider-map / managed-OpenRouter paid defaults — see [providers.md](reference/providers.md)).

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
| [grok-oauth.md](grok-oauth.md) | Sign in with X — Grok subscription access without an API key |
| [deploy/vps.md](deploy/vps.md) | Run the daemon on a VPS (installer or Docker) |
| [migrate-from-openclaw.md](migrate-from-openclaw.md) | Surface map from OpenClaw |
| [migrate-from-hermes.md](migrate-from-hermes.md) | Surface map from Hermes Agent |
| [trajectory-training-data.md](trajectory-training-data.md) | Enable trajectory export and curate SFT/DPO JSONL |
| [agent-eval-reports.md](agent-eval-reports.md) | Local agent-eval suite, reports, and regression gate |
| [provider-tool-compat.md](provider-tool-compat.md) | Tool JSON-schema root-type requirements for strict providers |
| [embedded-neovim-buffer.md](embedded-neovim-buffer.md) | BUFFER providers, nvim trust boundary, env knobs |
| [browser.md](browser.md) | Browser tool, Chromium profile, SSRF proxy, `[browser]` config |
| [sdk.md](sdk.md) | Embed via `@tetsuo-ai/agenc-sdk` (socket + subprocess) |
| [security/slm-transaction-guard.md](security/slm-transaction-guard.md) | Opt-in SLM CourtGuard for Solana-like tool calls |
| [security/mobile-ledger-transfer.md](security/mobile-ledger-transfer.md) | Typed Android `@ledger` SOL handoff: trust boundary, schemas, idempotency, recovery |

## Reference

| Doc | Summary |
| --- | --- |
| [reference/cli.md](reference/cli.md) | Full CLI: top-level flags, all subcommands |
| [reference/config.md](reference/config.md) | `config.toml` sections, env overrides, `agenc config` |
| [reference/daemon.md](reference/daemon.md) | Daemon process model, socket auth, lifecycle |
| [reference/providers.md](reference/providers.md) | Built-in providers, defaults, API key envs |
| [reference/slash-commands.md](reference/slash-commands.md) | TUI slash registry: names, aliases, purpose |
| [reference/autonomy.md](reference/autonomy.md) | Budget + heartbeat + cron delivery + hooks HTTP |
| [reference/agents.md](reference/agents.md) | Background agents + multi-agent v2 tools |
| [reference/memory.md](reference/memory.md) | Persona, AGENC.md, auto-memory paths, privacy |
| [reference/mcp.md](reference/mcp.md) | MCP client and server |
| [reference/skills-plugins.md](reference/skills-plugins.md) | Skills load paths, plugin CLI, registration surfaces |
| [reference/hooks.md](reference/hooks.md) | Session lifecycle hooks vs gateway HTTP hooks |
| [reference/tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) | LIVE tool catalog (by family), dual catalog note, permission modes, OS sandbox |
| [reference/tui-workbench.md](reference/tui-workbench.md) | TUI shell, workbench, BUFFER summary |

## Explanation

| Doc | Summary |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process model, subsystem map, turn phases, recovery ladder, on-disk state |
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
| [archive/bug-audit-2026-07-11.md](archive/bug-audit-2026-07-11.md) | Historical RCA (daemon multi-session singletons); all findings fixed |

---

## Outside `docs/` (still useful)

Tracked in the repo (safe for GitHub clones):

| Path | Summary |
| --- | --- |
| [`../README.md`](../README.md) | Product README (0.6.0) |
| [`../packages/agenc-sdk/README.md`](../packages/agenc-sdk/README.md) | SDK package readme |
| [`../runtime/eval/README.md`](../runtime/eval/README.md) | Agent-eval harness notes |
| [`../runtime/src/tui/README.md`](../runtime/src/tui/README.md) | TUI architecture (Ink fork, themes) |
| [`../runtime/src/mcp-client/README.md`](../runtime/src/mcp-client/README.md) | Outbound MCP client notes |
| [`../runtime/src/agents/v2/PARITY.md`](../runtime/src/agents/v2/PARITY.md) | Multi-agent v2 tool parity |
| [`../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md`](../runtime/src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md) | Web-search provider config |
| [`../runtime/src/llm/providers/openai-compatible/README.md`](../runtime/src/llm/providers/openai-compatible/README.md) | Provider naming note |
| [`../parity/agent-surface-contract.reviews/README.md`](../parity/agent-surface-contract.reviews/README.md) | Agent-surface contract reviews |
| [`../parity/embedded-neovim-buffer.reviews/README.md`](../parity/embedded-neovim-buffer.reviews/README.md) | Embedded-Neovim contract reviews |

Local-only (gitignored — not shipped on GitHub): contributor working files such
as `AGENTS.md` and `TODO.md`. Product backlog for public readers is
[roadmap.md](roadmap.md).
