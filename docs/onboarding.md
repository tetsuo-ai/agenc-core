# Onboarding AgenC (operator guide)

**Current release: 0.7.2.** This is the live product guide for first-run and
the multi-act setup path. Historical implementation notes live under
[archive/onboarding-plan-2026-07.md](archive/onboarding-plan-2026-07.md)
(archived — not product truth).

Related: [quickstart](quickstart.md) · [install](install.md) ·
[gateway](gateway.md) · [managed OpenRouter](managed-openrouter.md) ·
[remote control](remote-control.md) · [VPS](deploy/vps.md).

## North star

From `curl … | sh`:

| Clock | Target | Meaning |
|---|---|---|
| **T2M** | ~5 minutes | First useful model reply |
| **T2A** | ~15 minutes | Named agent, reachable from your phone, with a spend cap |

Act 1 alone leaves a complete TUI assistant. Acts 2–3 are invitations, not
gates — re-enter anytime with `agenc onboard <act>`.

## Principles

1. **Secure by default.** Every surface that opens shows its posture
   (loopback · token · pairing). The wizard never asks you to weaken
   security to finish.
2. **Budget before autonomy.** Heartbeat, cron, and hooks never enable before
   a spend envelope exists (or you visibly choose "no cap").
3. **The live smoke is the step.** Channel and autonomy steps aim to *do the
   thing once for real*, not only write config.
4. **Progressive, resumable.** Per-act completion is tracked locally; no
   phone-home telemetry.
5. **One writer per file.** Onboarding writes the same paths the runtime
   reads (`config.toml`, `gateway/config.json`, `gateway/env`, persona files,
   `HEARTBEAT.md`).

## Commands

```bash
agenc onboard              # launch Act 1 wizard (re-runs even after complete)
agenc onboard identity     # Act 2a — name your agent
agenc onboard channel      # Act 2b — Telegram / Discord / Slack / WebChat
agenc onboard autonomy     # Act 3 — budget → heartbeat → cron → hooks
agenc onboard recap        # posture summary + starter prompts
agenc onboard --status     # non-interactive report (wizard + acts + daemon)
agenc onboard --json       # with --status: JSON report
agenc onboard --reset      # clear first-run completed/seen flags
```

## Act 1 — first-run wizard

Launched by `agenc onboard` (or first interactive start). Step order is fixed
in `runtime/src/onboarding/Onboarding.tsx` (`FIRST_RUN_STEP_ORDER`):

1. **preflight** — environment / install sanity
2. **theme** — dark / light / system
3. **provider** — built-in providers, local runtimes, managed OpenRouter when
   logged in
4. **api-key** — live verification for key-required providers (skipped for
   local / managed paths when appropriate)
5. **connection-test** — real provider check
6. **security** — fail-closed defaults
7. **terminal-setup** — shell/terminal integration

Then you are in chat. Flags:

- `--status` — scripts and CI
- `--reset` — show the wizard again next interactive start (does not wipe
  keys, persona, or gateway config)

Credentials: BYOK env keys, pasted keys, local Ollama/LM Studio, or
`agenc login` for remote auth + managed OpenRouter (default
`auth.managedKeys.enabled = true`). Free accounts can use hosted `:free`
routes; paid default model is `x-ai/grok-4.5`. See
[managed-openrouter.md](managed-openrouter.md).

## Act 2a — identity

```bash
agenc onboard identity
```

- Chooses a persona workspace (default under home / suggested path).
- Scaffolds **`SOUL.md`** and **`USER.md`** if missing (never clobbers).
- Writes **`BOOTSTRAP.md`** and runs the one-time naming ritual so the agent
  writes **`IDENTITY.md`** (exactly-once: ritual injects only while
  `IDENTITY.md` is absent).
- Marks the workspace trusted for that ritual turn (`acceptEdits` is the
  narrow mode that allows writing `IDENTITY.md`; the wizard says so before
  running).

Editing those markdown files **is** the API. Details match the OpenClaw-style
convention documented in [migrate-from-openclaw.md](migrate-from-openclaw.md).

## Act 2b — channel

```bash
agenc onboard channel
```

Pick a surface:

| Surface | Secrets (in `gateway/env`, mode 0600) | Notes |
|---|---|---|
| **Telegram** | `AGENC_TELEGRAM_BOT_TOKEN` | Recommended 2-minute path; @BotFather |
| **Discord** | `AGENC_DISCORD_BOT_TOKEN` | Enable **MESSAGE CONTENT** intent |
| **Slack** | `AGENC_SLACK_BOT_TOKEN` + `AGENC_SLACK_APP_TOKEN` | Socket Mode; both required |
| **WebChat** | none extra | Loopback URL + token; no third-party account |

Tokens are **live-validated** before anything persists. Unknown DM senders stay
**pairing-gated**. The act walks pairing: message the bot, receive a code,
confirm, see the agent answer.

Always-on after setup:

```bash
agenc gateway install-service
# Linux: systemctl --user status agenc-gateway
# macOS: launchd dev.agenc.gateway
```

Full channel reference: [gateway.md](gateway.md).

**Not in this act:** Signal, WhatsApp, and email channels (not shipped). The
act does not configure the **Browser** tool either — that is a LIVE coding-agent
tool (isolated Chromium + SSRF proxy), not a messaging channel; see
[browser.md](browser.md) and [tools-permissions-sandbox.md](reference/tools-permissions-sandbox.md).

## Act 3 — autonomy (hard order)

```bash
agenc onboard autonomy
```

Order is enforced in code (`runtime/src/onboarding/acts/autonomy.ts`):

1. **Budget** — daily/monthly spend envelope (or explicit "no cap")
2. **Heartbeat** — `HEARTBEAT.md` + `[heartbeat]` / `AGENC_HEARTBEAT*`
3. **Cron** — scheduled jobs with optional channel delivery
4. **Hooks** — enable gateway `hooks.enabled` + token for `POST /hooks/agent`

Every sub-step is skippable. Config writes are conservative: TOML sections
append only when absent; existing sections are shown with edit instructions
rather than rewritten.

Heartbeat and channel turns are **live** against the daemon — not blocked on
legacy task trackers. Every autonomous tick still passes the budget admit
gate.

## Recap

```bash
agenc onboard recap
```

Shows security audit result, which acts completed, persona files present,
channels configured, budget/heartbeat/hooks posture, and starter prompts to
try next.

## Status report

```bash
agenc onboard --status
agenc onboard --status --json
```

Includes first-run completion, selected provider/model when known, per-act
completion, and daemon pid/running state.

## Recommended 15-minute path

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
agenc onboard
agenc security audit
agenc onboard identity
agenc onboard channel
agenc gateway install-service
agenc onboard autonomy
agenc onboard recap
```

On a VPS, enable linger so user units survive logout:

```bash
loginctl enable-linger "$USER"
```

See [deploy/vps.md](deploy/vps.md).

## Optional: remote phone control of the coding daemon

Channels (Act 2b) put a **chat bot** on Telegram/Discord/Slack. Separately,
**remote control** lets the **iOS or Android** app drive coding sessions on
your machine through a signed relay:

```bash
agenc login
agenc remote on
```

Requires a remote auth session; default daemon `ws://127.0.0.1:7766`.
[remote-control.md](remote-control.md).

## Where state lives

| Path | Purpose |
|---|---|
| `$AGENC_HOME/config.toml` | provider, budget, heartbeat, … |
| `$AGENC_HOME/gateway/config.json` | channel policies, bindings, hooks |
| `$AGENC_HOME/gateway/env` | bot tokens (0600) |
| `$AGENC_HOME/gateway/pairing.json` | paired peers |
| Workspace `SOUL.md` / `USER.md` / `IDENTITY.md` / `BOOTSTRAP.md` | persona |
| Workspace `HEARTBEAT.md` | proactive tick instructions |

## Security checklist after onboarding

```bash
agenc security audit
agenc doctor
agenc gateway status
agenc gateway pairing list
```

Green audit on a public VPS means: loopback daemon, secrets mode-restricted,
hooks not enabled without a token, no accidental open DM policy.
