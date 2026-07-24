# AgenC in 5 minutes (your agent in 15)

**Current release: 0.9.1.** The public installer and npm package resolve to the
same reviewed immutable runtime release.

Prerequisites: Node.js **>=25.9 <26** (release toolchain: 25.9.0), `tar`, and a way to reach a model — BYOK
(xAI / OpenAI / Anthropic / OpenRouter / …), a local Ollama or LM Studio
endpoint, or an AgenC login for managed OpenRouter (including free hosted
`:free` routes). Sixteen built-in providers are supported.

Related: [install](install.md) · [onboarding](onboarding.md) ·
[gateway](gateway.md) · [managed OpenRouter](managed-openrouter.md) ·
[remote control](remote-control.md) · [VPS](deploy/vps.md).

## 1. Install

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

Verifies the runtime tarball sha256, installs the `agenc` wrapper into
`~/.local/bin`, and starts the daemon as a user service. Other paths (npm,
Docker, Windows): [install.md](install.md). Update later with `agenc update`.

## 2. Act 1 — first conversation

```bash
agenc onboard
```

First-run wizard order:

1. **preflight**
2. **theme**
3. **provider**
4. **api-key** (live-verified when required)
5. **connection-test**
6. **security**
7. **terminal-setup**

Then you land in chat. Re-run any time; scripts use:

```bash
agenc onboard --status
agenc onboard --reset    # show the wizard again on next interactive start
```

Optional: `agenc login` for remote auth + managed models
([managed-openrouter.md](managed-openrouter.md)). BYOK env keys always win
over managed vending.

## 3. Check your posture

```bash
agenc security audit
```

Fresh installs audit green. Critical findings: `--fix` applies safe
permission fixes; exposure findings (non-loopback daemon overrides) list
manual remediation. `agenc doctor` diagnoses the installation itself.

## 4. Use it

```bash
agenc                                  # interactive TUI
agenc "summarize this repository"      # TUI with a first prompt
agenc --no-tui "run the tests"         # headless one-shot
agenc daemon status                    # daemon owns sessions/agents
```

Inside the TUI: `/help` lists slash commands. Background agents (flags before
the objective):
`agenc agent start [--unattended-allow <tools>] [--unattended-deny <tools>] <objective>`.
Resume with `--continue` / `--resume`.

## 5. Act 2 — make it YOUR agent

```bash
agenc onboard identity     # SOUL.md / USER.md + one-time naming ritual → IDENTITY.md
agenc onboard channel      # Telegram / Discord / Slack / WebChat
                           # live token checks, secrets in gateway/env (0600), pairing walkthrough
agenc gateway install-service   # always-on gateway (systemd/launchd)
```

Editing persona files **is** the API. Channel setup never weakens the
pairing-default posture: strangers who find your bot get a code, not your
agent. Details: [onboarding.md](onboarding.md), [gateway.md](gateway.md).

## 6. Act 3 — bounded autonomy

```bash
agenc onboard autonomy     # budget FIRST, then heartbeat → cron → hooks
agenc onboard recap        # posture summary + things to try
```

Nothing autonomous enables before a spend cap exists (or you visibly choose
"no cap"). When a cap is hit, autonomy pauses and tells you — never silent
spend, never silent stop.

Heartbeat is **live** (`agenc gateway run --heartbeat` or `[heartbeat]` config).
Hooks: `agenc gateway run --hooks` / `hooks.enabled` → loopback
`POST /hooks/agent` with header-only bearer auth.

## 7. Optional: phone remote control

Pair an **iOS or Android** app with the host daemon:

```bash
agenc login
agenc remote on            # code + QR; needs remote auth session
agenc remote status
agenc remote off
```

Daemon default: `ws://127.0.0.1:7766`. Full flow: [remote-control.md](remote-control.md).

## Migrating

Coming from another assistant?

- [Migrate from OpenClaw](migrate-from-openclaw.md)
- [Migrate from Hermes](migrate-from-hermes.md)

## Not shipped (do not expect these yet)

Signal, WhatsApp, and email channels are not in 0.9.1.
Telegram, Discord, Slack, WebChat, and stdio **are** shipped via
`agenc gateway`.
