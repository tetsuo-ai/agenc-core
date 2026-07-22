# AgenC documentation index

Canonical map of docs under `docs/`. Product overview and install entry:
[`../README.md`](../README.md).

Version in tree: **runtime / launcher 0.8.5**; embedding SDK
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
| [evaluation-contract-v1.md](evaluation-contract-v1.md) | Versioned real-agent task, preregistration, evidence, and score derivation contract |
| [evaluation-suites-v1.md](evaluation-suites-v1.md) | Separate versioned competitive-coding and deterministic trust-conformance suite protocols |
| [evaluation-pilot-v1.md](evaluation-pilot-v1.md) | Frozen 30-task public pilot candidates, qualification boundary, and powered-holdout design |
| [ci-required-gates.md](ci-required-gates.md) | Local exact-SHA gates and the inactive optional GitHub App/ruleset design |
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
| [design/budget-enforcement.md](design/budget-enforcement.md) | Historical budget research and superseded surface-ledger design |
| [design/reproducible-installs-releases.md](design/reproducible-installs-releases.md) | M0 dependency, artifact, Docker, release, and crash-safe lock decisions |
| [design/workspace-scoped-agent-roles.md](design/workspace-scoped-agent-roles.md) | Immutable workspace identity for role lookup, spawn, resume, and worktrees |
| [design/secure-project-instructions.md](design/secure-project-instructions.md) | Live instruction delivery, precedence, descriptor-bound reads, approvals, and threat model |
| [design/fail-closed-sandbox-execution.md](design/fail-closed-sandbox-execution.md) | Required process isolation boundary, platform probes, failure semantics, and research |
| [design/execution-admission-kernel.md](design/execution-admission-kernel.md) | M3 daemon admission, durable budgets/queue/cancellation, evidence, rollout, and rollback |
| [design/durable-runs-effects-events.md](design/durable-runs-effects-events.md) | M4 canonical run journal, honest effects, terminal results, replay-safe cursors, crash matrix, and rollback |
| [roadmap.md](roadmap.md) | Shipped vs open backlog (current product truth) |

## Releases

| Doc | Summary |
| --- | --- |
| [releases/0.8.5.md](releases/0.8.5.md) | AgenC 0.8.5: assistant text segment boundaries on the live wire, resumed sessions render replayed tools |
| [releases/0.8.4.md](releases/0.8.4.md) | AgenC 0.8.4: grok stream_idle root fix (xAI silent tool-arg generation, 600s tolerance), real ctx% + tok/s, swarm perf |
| [releases/0.8.3.md](releases/0.8.3.md) | AgenC 0.8.3: production React — fixes the long-session TUI heap OOM (dev-mode PerformanceMeasure leak) |
| [releases/0.8.2.md](releases/0.8.2.md) | AgenC 0.8.2: /ledger command + Ledger TUI indicator, /swarm mode, approval cards rebuilt as real pickers, ptyxis flicker fix |
| [releases/0.8.1.md](releases/0.8.1.md) | AgenC 0.8.1: OAuth refresh race, honest usage/rate, long-session hardening (schema v16), M5 review adoption |
| [releases/0.8.0.md](releases/0.8.0.md) | AgenC 0.8.0: the verified-change workflow (agenc run start), grok streaming resilience, picker redesign |
| [releases/0.7.3.md](releases/0.7.3.md) | AgenC 0.7.3: grok stream idle timeout, provider timeout_ms, launcher perms repair and update-deadlock fixes |
| [releases/0.7.2.md](releases/0.7.2.md) | AgenC 0.7.2: durable runs, verified distribution, TUI workbench, lifecycle and sandbox hardening |
| [releases/0.7.1.md](releases/0.7.1.md) | Source-tag-only 0.7.1 candidate (no runtime or npm publication) |
| [releases/0.7.0.md](releases/0.7.0.md) | Source-tag-only 0.7.0 candidate (no runtime or npm publication) |
| [releases/0.6.2.md](releases/0.6.2.md) | Superseded 0.6.2 source candidate (no runtime or npm publication) |

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
| [`../README.md`](../README.md) | Product README (0.8.5) |
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
