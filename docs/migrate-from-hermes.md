# Migrating from Hermes Agent

Hermes and AgenC are both daemon-backed, model-agnostic agents. The honest
difference: Hermes leads on the self-learning loop and messaging reach; AgenC
leads on execution safety (OS sandbox, fail-closed permissions), state
auditability, and engineering rigor (14k tests, typed daemon protocol,
eval-regression gate). This guide maps the surfaces, including what AgenC
does not have yet.

## Install + first run

```bash
curl -fsSL <installer-url>/install.sh | sh
agenc onboard          # provider/key wizard — BYOK or OAuth-backed providers
agenc security audit   # fail-closed posture check, green on fresh installs
```

## Concept map

| Hermes | AgenC | Notes |
|---|---|---|
| `hermes gateway` | `agenc daemon` | Loopback-only by default, refuses non-loopback binds without an explicit override |
| Ink TUI / curses CLI | TUI (`agenc`) | Custom react-reconciler TUI + embedded Neovim workbench |
| Model providers (~30 plugins) | 16 built-in providers | Anthropic/OpenAI/Grok/Gemini/Bedrock/OpenRouter/Groq/DeepSeek/…, local via Ollama/LM Studio/openai-compatible; per-session `--provider/--model` |
| Skills + Skills Hub | Skills + plugins | Local + bundled skills, plugin marketplaces via `agenc plugin`; no public hub until publishing is signed + attested (deliberate) |
| Curator (self-created skills) | Roadmap — auditable by design | Planned as reviewed, git-versioned, eval-gated proposals; never silent self-modification. The eval harness that gates it already ships |
| FTS session search | Roadmap | Sessions already persist to SQLite; cross-session search is planned |
| Memory + user modeling | `memory/` + memdir | Project/session memory with aging; user-model files planned as proposed diffs, never silent writes |
| `delegate_task` / async children | Subagents + teams + jobs | Worktree-isolated background agents, workflow runner (waves/deps), CSV fan-out |
| Checkpoints `/undo` `/retry` | `/rewind` | Sidecar-based file restore to any message barrier |
| Sandboxing (docker/ssh/modal/…) | OS sandbox (bwrap/Landlock/Seatbelt) | Kernel-level confinement locally; docker/ssh execution targets are on the roadmap |
| Messaging platforms (~21) | Roadmap | The next major phase; the typed daemon protocol + zero-dep SDK already expose session attach/stream/permission round-trips for channel adapters |
| ACP (Zed/IDE) | IDE-as-MCP seam | No shipped editor extension yet |
| `hermes update` | Launcher-managed | Runtime tarballs are sha256-verified on install; `agenc doctor` reports update permissions |
| Cost `/usage` | `/cost` | Per-agent cost attribution, cache metrics |
| Batch/trajectory research tooling | `agenc trajectories export` | SFT/DPO JSONL export with redaction re-applied per row |

## Two design disagreements, stated plainly

1. **Learning must be reviewable.** Hermes' curator edits its own skills in
   place; the community's top complaint is silent drift. AgenC will land the
   same capability as draft diffs gated by the eval harness, with one-command
   revert.
2. **External content is untrusted, always.** Web results, task text, and
   (when they ship) channel messages are wrapped and can never escalate
   permissions or approve a previewed action. That rule is enforced in code
   and tested, not stated in a system prompt.

## What you lose today

The messaging gateway, voice/TTS breadth, ACP editor integration, the
self-improving loop, and remote execution backends. If those are your daily
drivers, run both while the roadmap closes the gap — the phases are public in
this repo's parity roadmap.
