# AgenC documentation index

Canonical map of docs under `docs/`. Product overview and install entry:
[`../README.md`](../README.md).

Version in tree: **runtime / launcher 0.17.0**; embedding SDK
**0.3.0**. Default provider **grok**; fresh-config session and direct-provider
default **grok-4.6**. Managed OpenRouter's paid default remains
**`x-ai/grok-4.5`** (see [providers.md](reference/providers.md)).

Layout follows a Diataxis-ish split: tutorials (start here), how-to, reference,
explanation. Superseded planning and audit material remains available in Git
history; the linked pages below are current product truth.

---

## Tutorials

| Doc | Summary |
| --- | --- |
| [quickstart.md](quickstart.md) | Install → onboard → first chat in minutes |
| [install.md](install.md) | Installer, npm, Docker, Windows, update path, sized download deadlines, AppArmor/Landlock, and home-as-workspace |
| [onboarding.md](onboarding.md) | First-run wizard + acts (identity, channel, autonomy, recap) |

## How-to

| Doc | Summary |
| --- | --- |
| [gateway.md](gateway.md) | Channel gateway: Telegram, Discord, Slack, WebChat, stdio; pairing; heartbeat/hooks |
| [remote-control.md](remote-control.md) | Pair host with AgenC phone app (`agenc remote`) |
| [managed-openrouter.md](managed-openrouter.md) | Hosted OpenRouter / managed keys via remote auth |
| [grok-oauth.md](grok-oauth.md) | Sign in with X for Grok subscription access without an API key (`agenc grok-login` + TUI) |
| [deploy/vps.md](deploy/vps.md) | Run the daemon on a VPS (installer or Docker) |
| [migrate-from-openclaw.md](migrate-from-openclaw.md) | Surface map from OpenClaw |
| [migrate-from-hermes.md](migrate-from-hermes.md) | Surface map from Hermes Agent |
| [trajectory-training-data.md](trajectory-training-data.md) | Enable trajectory export and curate SFT/DPO JSONL |
| [agent-eval-reports.md](agent-eval-reports.md) | Legacy local diagnostic suite, reports, and regression gate (not TFR) |
| [evaluation-contract-v1.md](evaluation-contract-v1.md) | Versioned real-agent task, preregistration, evidence, and score derivation contract |
| [evaluation-suites-v1.md](evaluation-suites-v1.md) | Separate versioned competitive-coding and deterministic trust-conformance suite protocols |
| [evaluation-pilot-v1.md](evaluation-pilot-v1.md) | Frozen 30-task public pilot candidates, qualification boundary, and powered-holdout design |
| [eval/real-agent-baseline-runbook.md](eval/real-agent-baseline-runbook.md) | Operator runbook for reproducible real-agent pilot batches from pinned inputs, including fail-closed CLI parsing |
| [eval/seed-baseline-2026-07-17.md](eval/seed-baseline-2026-07-17.md) | Dated snapshot: first contained 10-task real-agent scorecard (2026-07-17, runtime 0.6.1). Not a reproduction contract |
| [ci-required-gates.md](ci-required-gates.md) | Local exact-SHA gates and the inactive optional GitHub App/ruleset design |
| [provider-tool-compat.md](provider-tool-compat.md) | Wire-schema shaping: object-root tools, llama.cpp grammar-safe schemas, Gemini allowlist, LM Studio/openai-compatible 8192 ceiling |
| [embedded-neovim-buffer.md](embedded-neovim-buffer.md) | Embedded Neovim workspace, multi-buffer safety, recovery, editor/chat handoff, configuration, troubleshooting, and hosted PTY split |
| [browser.md](browser.md) | Browser tool, Chromium profile, SSRF proxy, `[browser]` config |
| [imagine.md](imagine.md) | Grok ImagineImage / ImagineVideo tools (direct xAI only) |
| [sdk.md](sdk.md) | Embed via `@tetsuo-ai/agenc-sdk` (socket + subprocess), including `startRun` model/provider |
| [security/slm-transaction-guard.md](security/slm-transaction-guard.md) | Opt-in SLM CourtGuard for Solana-like tool calls |
| [security/mobile-ledger-transfer.md](security/mobile-ledger-transfer.md) | Typed Android `@ledger` SOL handoff: trust boundary, schemas, idempotency, recovery |

## Reference

| Doc | Summary |
| --- | --- |
| [reference/cli.md](reference/cli.md) | Full CLI, including M5 `run start`, Grok auth, OpenAI model discovery, and `agenc skills list` |
| [reference/config.md](reference/config.md) | `config.toml` sections, env overrides, `agenc config` |
| [reference/env.md](reference/env.md) | Operator `AGENC_*` / provider key environment variables, and provider credential isolation |
| [reference/daemon.md](reference/daemon.md) | Daemon lifecycle, socket auth, deferred first messages, bypass consent, bounded-stop survival, and admission step identity |
| [reference/providers.md](reference/providers.md) | Built-in providers, defaults, API key envs, local context-window probes, Responses continuation, and overflow diagnostics |
| [reference/slash-commands.md](reference/slash-commands.md) | TUI slash registry, including exact `/swarm` status/on/off semantics |
| [reference/autonomy.md](reference/autonomy.md) | Budget + heartbeat + cron delivery (pinned webhook destinations) + hooks HTTP |
| [reference/agents.md](reference/agents.md) | Background agents, multi-agent v2 lifecycle/admission, deferred first message, worktree evidence, and turn-scoped abort |
| [reference/workflows.md](reference/workflows.md) | Version-2 agent DAG manifests, scheduling, handoff artifacts, limits, and result outcomes |
| [reference/memory.md](reference/memory.md) | Persona, AGENC.md, auto-memory paths, full-corpus index, privacy |
| [reference/mcp.md](reference/mcp.md) | MCP client and server, plugin-declared server precedence, and Landlock diagnostics |
| [reference/skills-plugins.md](reference/skills-plugins.md) | Skills, `agenc skills list`, plugin registration, marketplace install, publisher signatures, and repository-controlled scope stripping |
| [reference/hooks.md](reference/hooks.md) | Session lifecycle hooks vs gateway HTTP hooks |
| [reference/tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md) | LIVE tool catalog (by family), dual catalog note, permission modes, live bypass consent, OS sandbox, home-workspace remediation, launcher contract, and plugin MCP confinement |
| [reference/tui-workbench.md](reference/tui-workbench.md) | TUI shell, workbench layout, BUFFER operator shortcuts, and safety prompts |

## Explanation

| Doc | Summary |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process model, subsystem map, turn phases, recovery ladder, on-disk state |
| [design/critical-path/README.md](design/critical-path/README.md) | Critical-path ADRs. Several are shipped (see that README's per-ID status). Remaining target: CP-0008 flattening cutover |
| [design/reproducible-installs-releases.md](design/reproducible-installs-releases.md) | M0 dependency, artifact, Docker, release, and crash-safe lock decisions |
| [design/release-controller.md](design/release-controller.md) | Proposed one-command resumable release controller and automation safety contract |
| [design/workspace-scoped-agent-roles.md](design/workspace-scoped-agent-roles.md) | Immutable workspace identity for role lookup, spawn, resume, and worktrees |
| [design/secure-project-instructions.md](design/secure-project-instructions.md) | Live instruction delivery, precedence, descriptor-bound reads, approvals, and threat model |
| [design/fail-closed-sandbox-execution.md](design/fail-closed-sandbox-execution.md) | Required process isolation boundary, platform probes, launcher argv contract, failure semantics, and research |
| [design/reconnect-backoff-policy.md](design/reconnect-backoff-policy.md) | Finite full-jitter reconnect policy, typed Retry-After parsing, elapsed accounting, and A1 replay-safety ordering |
| [design/execution-admission-kernel.md](design/execution-admission-kernel.md) | M3 daemon admission, model step identity, durable budgets/queue/cancellation, evidence, rollout, and rollback |
| [design/provider-aware-token-accounting.md](design/provider-aware-token-accounting.md) | Complete-request native/fallback accounting, bounded cache/single-flight, context enforcement, context estimates, and calibration |
| [design/durable-runs-effects-events.md](design/durable-runs-effects-events.md) | M4 canonical run journal, honest effects, resume with pending reviews, terminal results, replay-safe cursors, crash matrix, and rollback |
| [design/shared-run-contracts-v1.md](design/shared-run-contracts-v1.md) | Frozen v1 run, admission, budget, effect, event, and cursor contracts |
| [design/verified-change-workflow-m5.md](design/verified-change-workflow-m5.md) | Verified-change workflow contract, session bootstrap, child names, review repair, run refs, and evidence |
| [design/eval-pilot-executor.md](design/eval-pilot-executor.md) | Pilot preflight and offline-agent executor. Phase 2b egress shipped. Evidence-ledger binding in eval-executor is still target |
| [design/eval-pilot-executor-phase2b-egress.md](design/eval-pilot-executor-phase2b-egress.md) | Contained real-provider egress implementation and adversarial proof record |
| [design/swarm-orchestration.md](design/swarm-orchestration.md) | Enforced initial delegation for parallel routing, durable task outcomes, immutable worktree evidence, external research, and local evaluation gate |
| [design/mailbox-metadata-contract.md](design/mailbox-metadata-contract.md) | Bounded mailbox metadata decoder/builder (E3a). Implemented |
| [design/mailbox-metadata-cutover.md](design/mailbox-metadata-cutover.md) | Mailbox.send admits only authenticated metadata handles (E3b) |
| [roadmap.md](roadmap.md) | Shipped vs open backlog (current product truth) |

## Releases

| Doc | Summary |
| --- | --- |
| [releases/0.17.0.md](releases/0.17.0.md) | AgenC 0.17.0: restart-safe resumable sessions, race-safe protocol 1.2 client sync, Linux Landlock fallback, and reliable large tool-output handling |
| [releases/0.16.1.md](releases/0.16.1.md) | AgenC 0.16.1: stock-macOS installer repair, live install progress, launcher portability, and reliable supervised-process teardown |
| [releases/0.16.0.md](releases/0.16.0.md) | AgenC 0.16.0: grok-4.6 as the startup default, first-party security plugin, and recovery from stale workspace process state |
| [releases/0.15.0.md](releases/0.15.0.md) | AgenC 0.15.0: daemon port ownership and reaping, working mode-switcher keys, readable failures |
| [releases/0.14.2.md](releases/0.14.2.md) | AgenC 0.14.2: scoped stale workspace quarantine and authoritative shell effect outcomes |
| [releases/0.14.1.md](releases/0.14.1.md) | AgenC 0.14.1: emergency patch unbricking 0.13 to 0.14 daemon upgrades and surfacing failed submits |
| [releases/0.14.0.md](releases/0.14.0.md) | AgenC 0.14.0: durable recovery, scalable workflows, faster search and editing, and stronger execution safety |
| [releases/0.13.0.md](releases/0.13.0.md) | AgenC 0.13.0: unified Agent/Editor workspace, safe AI-assisted Neovim editing, and first-class Ledger verification |
| [releases/0.12.0.md](releases/0.12.0.md) | AgenC 0.12.0: monochrome terminal workbench, reliable delegated-agent admission, and zero-skip native gates |
| [releases/0.11.2.md](releases/0.11.2.md) | AgenC 0.11.2: first published self-contained Node 26 runtime, with Rocky-built compatibility bootstraps |
| [releases/0.10.0.md](releases/0.10.0.md) | AgenC 0.10.0: parallel `/swarm` routes now perform a real initial worker-spawn attempt |
| [releases/0.9.5.md](releases/0.9.5.md) | AgenC 0.9.5: accurate native-install diagnostics and an actionable Ubuntu AppArmor sandbox fix |
| [releases/0.9.4.md](releases/0.9.4.md) | AgenC 0.9.4: first-run AgenC and X / xAI sign-in, free hosted models, and actionable onboarding |
| [releases/0.9.3.md](releases/0.9.3.md) | AgenC 0.9.3: default wrapper-directory permission repair, concise installer failures, resumable exact-SHA releases, installer-only hotfix channel |
| [releases/0.9.2.md](releases/0.9.2.md) | AgenC 0.9.2: swarm workers freed from implicit runtime limits, swarm status/transcript polish, shell-quote 1.10.0 permission-parser fix, assign_task prompt matches admission |
| [releases/0.9.1.md](releases/0.9.1.md) | AgenC 0.9.1: hardened adaptive swarm orchestration (per-assignment receipts, worktree isolation, admission-gated spawn), resume-card root fix (0.9.0 burned unpublished on builder-pin drift) |
| [releases/0.8.5.md](releases/0.8.5.md) | AgenC 0.8.5: assistant text segment boundaries on the live wire, resumed sessions render replayed tools |
| [releases/0.8.4.md](releases/0.8.4.md) | AgenC 0.8.4: grok stream_idle root fix (xAI silent tool-arg generation, 600s tolerance), real ctx% + tok/s, swarm perf |
| [releases/0.8.3.md](releases/0.8.3.md) | AgenC 0.8.3: production React — fixes the long-session TUI heap OOM (dev-mode PerformanceMeasure leak) |
| [releases/0.8.2.md](releases/0.8.2.md) | AgenC 0.8.2: /ledger command + Ledger TUI indicator, /swarm mode, approval cards rebuilt as real pickers, ptyxis flicker fix |
| [releases/0.8.1.md](releases/0.8.1.md) | AgenC 0.8.1: OAuth refresh race, honest usage/rate, long-session hardening (schema v16), M5 review adoption |
| [releases/0.8.0.md](releases/0.8.0.md) | AgenC 0.8.0: the verified-change workflow (agenc run start), grok streaming resilience, picker redesign |
| [releases/0.7.3.md](releases/0.7.3.md) | AgenC 0.7.3: grok stream idle timeout, provider timeout_ms, launcher perms repair and update-deadlock fixes |
| [releases/0.7.2.md](releases/0.7.2.md) | AgenC 0.7.2: durable runs, verified distribution, TUI workbench, lifecycle and sandbox hardening |

---

## Outside `docs/` (still useful)

Tracked in the repo (safe for GitHub clones):

| Path | Summary |
| --- | --- |
| [`../README.md`](../README.md) | Product README (0.17.0) |
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
