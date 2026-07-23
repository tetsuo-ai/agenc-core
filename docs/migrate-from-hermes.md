# Migrating from Hermes Agent

Hermes and AgenC are both daemon-backed, model-agnostic agents. The honest
difference: Hermes leads on the self-learning loop and broader messaging
reach (Signal/WhatsApp/etc.); AgenC leads on execution safety (OS sandbox,
fail-closed permissions), state auditability, and engineering rigor (typed
daemon protocol, eval-regression gate, large test suite). This guide maps the
surfaces, including what AgenC does not have yet.

**AgenC 0.9.0.** Related: [quickstart](quickstart.md) ·
[onboarding](onboarding.md) · [gateway](gateway.md) ·
[OpenClaw migrate](migrate-from-openclaw.md).

## Install + first run

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
agenc onboard          # Act 1 wizard: preflight → theme → provider → key → …
agenc security audit   # fail-closed posture check, green on fresh installs
```

Optional product path:

```bash
agenc onboard identity
agenc onboard channel      # Telegram / Discord / Slack / WebChat
agenc gateway install-service
agenc onboard autonomy     # budget → heartbeat → cron → hooks
```

## Concept map

| Hermes | AgenC | Notes |
|---|---|---|
| `hermes gateway` | `agenc daemon` + `agenc gateway` | Daemon is loopback-only by default; channel gateway is a separate always-on client (`install-service`) |
| Ink TUI / curses CLI | TUI (`agenc`) | Custom react-reconciler TUI + embedded Neovim workbench |
| Model providers (~30 plugins) | 16 built-in providers | Anthropic/OpenAI/Grok/Gemini/Bedrock/OpenRouter/Groq/DeepSeek/…, local via Ollama/LM Studio/openai-compatible; managed OpenRouter + free `:free` routes; per-session `--provider`/`--model` |
| Skills + Skills Hub | Skills + plugins | Local + bundled skills, plugin marketplaces via `agenc plugin`; no public hub until publishing is signed + attested (deliberate) |
| Curator (self-created skills) | Roadmap — auditable by design | Planned as reviewed, git-versioned, eval-gated proposals; never silent self-modification. The eval harness that gates it already ships |
| FTS session search | Roadmap | Sessions already persist to SQLite; cross-session search is planned |
| Memory + user modeling | `memory/` + memdir | Project/session memory with aging; user-model files planned as proposed diffs, never silent writes |
| `delegate_task` / async children | Subagents + teams + jobs | Worktree-isolated background agents, workflow runner (waves/deps), CSV fan-out |
| Checkpoints `/undo` `/retry` | `/rewind` | Sidecar-based file restore to any message barrier |
| Sandboxing (docker/ssh/modal/…) | OS sandbox (bwrap/Landlock/Seatbelt) | Kernel-level confinement locally; docker/ssh execution targets are on the roadmap |
| Messaging platforms (~21) | **Shipped:** Telegram, Discord, Slack, WebChat, stdio | `agenc gateway run` (+ `install-service`); pairing-gated DMs, in-channel token approvals, untrusted-content framing. Discord: official Gateway WS + REST (`AGENC_DISCORD_BOT_TOKEN`). Slack: Socket Mode (`AGENC_SLACK_BOT_TOKEN` + `AGENC_SLACK_APP_TOKEN`). Signal / WhatsApp / email still not shipped |
| Heartbeat | **Live** | `agenc gateway run --heartbeat` / `[heartbeat]`; budget-gated ticks against `HEARTBEAT.md` |
| Cron / hooks | **Shipped** | Cron delivery to channels; loopback `POST /hooks/agent` with header-only bearer |
| ACP (Zed/IDE) | IDE-as-MCP seam | No shipped editor extension yet |
| `hermes update` | `agenc update` / launcher-managed | Runtime tarballs are sha256-verified on install |
| Cost `/usage` | `/cost` / `/usage` | Per-agent cost attribution; managed OpenRouter allowance via `/usage` after login |
| Batch/trajectory research tooling | `agenc trajectories export` | SFT/DPO JSONL export with redaction re-applied per row |

## Two design disagreements, stated plainly

1. **Learning must be reviewable.** Hermes' curator edits its own skills in
   place; the community's top complaint is silent drift. AgenC will land the
   same capability as draft diffs gated by the eval harness, with one-command
   revert.
2. **External content is untrusted, always.** Web results, task text, and
   channel messages are sanitized and wrapped and can never escalate
   permissions or approve a previewed action. That rule is enforced in code
   and tested, not stated in a system prompt.

## What you lose today

Voice/TTS breadth as a product surface (Telegram can do bounded xAI media
when enabled), ACP editor integration, the self-improving curator loop, remote
execution backends (docker/ssh/modal targets), and channel breadth beyond
Telegram/Discord/Slack/WebChat/stdio (no Signal, WhatsApp, or email yet).

Browser automation is **shipped**: the `Browser` tool drives an isolated
Chromium over a CDP pipe with accessibility-ref actions, SSRF-proxied egress,
and a dedicated profile — inside AgenC's permission/sandbox model.

If those are your daily drivers, run both while the gap closes. Persona files
(`SOUL.md` / `USER.md` / `IDENTITY.md`) and budget-before-autonomy onboarding
map cleanly if you are already thinking in "named agent on my phone."
