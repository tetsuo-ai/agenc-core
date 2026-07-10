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
| Control UI chat | TUI (`agenc`) + WebChat | Terminal-native, plus a loopback token-gated browser chat via `agenc gateway run --webchat` |
| `AGENTS.md` (workspace instructions) | `AGENC.md` | Generated/analyzed by `agenc init`; per-project instructions |
| `MEMORY.md` + daily notes | `memory/` + memdir | Automatic project/session memory with aging + retrieval |
| Skills (`SKILL.md` dirs, ClawHub) | Skills + plugins | Bundled + local skills; plugins add commands/tools/hooks/MCP via `agenc plugin` and `/plugins`. No public registry yet — by design until publishing is signed + attested |
| Cron (`openclaw cron`) | Cron tools + live scheduler | Create/list/delete from the agent; jobs re-arm on daemon restart. Delivery-routed jobs (`announceChannel`/`webhook` on CronCreate) run in isolated gateway sessions and post their result to a channel or webhook |
| Webhooks (`/hooks/agent`) | Shipped | Same endpoint shape: `agenc gateway run --hooks` (or gateway config `hooks.enabled`) serves loopback `POST /hooks/agent` with header-only bearer auth — query-string tokens are rejected outright. `message`/`name`/`agent`/`sessionKey`/`deliver` params; `deliver` streams the result to any running channel, no `deliver` returns it in the response. Payloads ride the untrusted-content framing and the `[budget]` envelope; `agenc security audit` flags enabled-without-token |
| `SOUL.md` / `IDENTITY.md` persona | Shipped | Same convention, same filenames — see "Persona workspace files" below |
| Heartbeat (`HEARTBEAT.md`) | Shipped | `agenc gateway run --heartbeat` (or `[heartbeat]` config): periodic turns read `HEARTBEAT.md`, deliver only non-OK results to a channel, and every tick is gated by the `[budget]` daily/monthly spend envelope — a refusal pauses instead of silently burning |
| Channels (Telegram, WhatsApp, …) | Shipped (Telegram, Discord, Slack, WebChat, stdio) | `agenc gateway run`; pairing-gated, with in-channel token approvals and untrusted-content framing. Discord rides the official Gateway WS + REST (`AGENC_DISCORD_BOT_TOKEN`); Slack rides Socket Mode — no inbound listener (`AGENC_SLACK_BOT_TOKEN` + `AGENC_SLACK_APP_TOKEN`); guild/channel messages are mention-gated by default. Signal and WhatsApp still roadmap |
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

## Persona workspace files

The OpenClaw persona convention works as-is, from the workspace root (the
directory the agent runs in):

- **`USER.md`** — who the human is: name, preferences, context.
- **`SOUL.md`** — the agent's persona, tone, and boundaries.
- **`IDENTITY.md`** — the agent's own established identity, usually written
  by the agent itself during the bootstrap ritual.
- **`BOOTSTRAP.md`** — a one-time ritual (typically a naming ceremony). It is
  injected only while `IDENTITY.md` does not exist, framed with instructions
  to complete the ritual, write `IDENTITY.md`, and delete `BOOTSTRAP.md`.
  Once `IDENTITY.md` exists the ritual is never injected again — the
  exactly-once guarantee is mechanical, not honor-system.

All four are injected into the system prompt as a dedicated persona section
(and ride the memory bootstrap as project-tier instructions). Files are
loaded from the workspace root only (never ancestor directories), absent
files cost nothing, and each file is budget-capped at 16 KiB in the prompt —
oversized content is truncated in context with a marker while the file on
disk stays intact. The section is computed at conversation start and stays
stable for that conversation (prompt-cache stability); persona edits and
ritual completion apply from the next new conversation. Copy your existing
`SOUL.md`/`USER.md`/`IDENTITY.md` over unchanged; they just work.

## What you lose today (roadmap, in priority order)

Browser automation, a mobile app, and channel breadth beyond
Telegram/Discord/Slack/WebChat (Signal, WhatsApp). If any of these is your
daily driver, run both: several of the gaps are next on the roadmap, and the
daemon architecture is built for exactly those clients.
