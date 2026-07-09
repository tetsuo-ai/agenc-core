# Migrating from OpenClaw

AgenC is a daemon-backed agent like OpenClaw's Gateway, with a different
center of gravity: OS-sandboxed execution, a fail-closed permission layer, and
an auditable state model. This guide maps concepts honestly — including what
AgenC does **not** have yet.

## Install + first run

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh   # sha256-verified, daemon as user service
agenc onboard                                # provider/key/theme wizard
agenc security audit                         # green by default; --fix for chmods
```

Reuse the same provider credential you used with OpenClaw (BYOK env vars or
`agenc login` for OAuth-backed providers).

## Concept map

| OpenClaw | AgenC | Notes |
|---|---|---|
| Gateway daemon | `agenc daemon` | Unix socket + loopback WebSocket; **non-loopback binds are refused** without an explicit override (audited) |
| Control UI chat | TUI (`agenc`) | Terminal-native; a web chat surface is on the roadmap |
| `AGENTS.md` (workspace instructions) | `AGENC.md` | Generated/analyzed by `agenc init`; per-project instructions |
| `MEMORY.md` + daily notes | `memory/` + memdir | Automatic project/session memory with aging + retrieval |
| Skills (`SKILL.md` dirs, ClawHub) | Skills + plugins | Bundled + local skills; plugins add commands/tools/hooks/MCP via `agenc plugin` and `/plugins`. No public registry yet — by design until publishing is signed + attested |
| Cron (`openclaw cron`) | Cron tools + live scheduler | Create/list/delete from the agent; jobs re-arm on daemon restart |
| Webhooks (`/hooks/agent`) | Roadmap | Planned with header-only bearer auth |
| `SOUL.md` / `IDENTITY.md` persona | Roadmap | Persona workspace files are planned; today AGENC.md carries operating instructions |
| Heartbeat (`HEARTBEAT.md`) | Roadmap | Planned budget-first (cheap utility model + hard daily caps) — idle-burn horror stories are a design input, not a surprise |
| Channels (Telegram/WhatsApp/…) | Roadmap | Channel gateway is the next major phase; the daemon protocol + SDK already expose everything an adapter needs |
| Nodes (phone/Canvas) | Roadmap | Realtime voice (WebRTC) already exists in the TUI |
| `openclaw security audit` | `agenc security audit --fix` | Fail-closed exit codes; runs automatically around onboard/daemon start |
| Docker install | `packaging/docker/` | Non-root image, no published ports by default |

## What you gain immediately

- **OS sandbox** (bubblewrap/Landlock/Seatbelt) for shell execution, not just
  an approval prompt; AST-backed Bash permissioning; transactional multi-file
  patches with rollback.
- **Session model**: append-only JSONL + SQLite, `--continue`/`--resume`,
  state export/import, `/rewind` file restore.
- **MCP both directions** (client + server), subagent teams and background
  agents in isolated worktrees, an eval-regression harness, and 16 model
  providers including Ollama/LM Studio.

## What you lose today (roadmap, in priority order)

Messaging channels, heartbeat/proactive behavior, persona files, webhooks,
browser automation, a mobile app. If any of these is your daily driver,
run both: several of the gaps are next on the roadmap, and the daemon
architecture is built for exactly those clients.
