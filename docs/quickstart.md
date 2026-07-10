# AgenC in 5 minutes (your agent in 15)

Prerequisites: Node.js >= 25, `tar`, and one model-provider credential (an
xAI/OpenAI/Anthropic/OpenRouter key, or a local Ollama/LM Studio endpoint —
16 providers are supported).

## 1. Install

```bash
curl -fsSL https://get.agenc.ag/install.sh | sh
```

This verifies the runtime tarball's sha256, installs the `agenc` wrapper into
`~/.local/bin`, and starts the daemon as a user service. Other paths (npm,
Docker, Windows): [`install.md`](install.md).

## 2. Guided setup

```bash
agenc onboard
```

The wizard walks provider → API key (verified live) → theme → connection
check → security defaults, then drops you into the chat. Re-run it any time;
`agenc onboard --status` reports setup state for scripts.

## 3. Check your posture

```bash
agenc security audit
```

Fresh installs audit green. If you ever see a critical finding, `--fix`
applies the safe permission fixes; exposure findings (non-loopback daemon
overrides) list their manual remediation. `agenc doctor` diagnoses the
installation itself.

## 4. Use it

```bash
agenc                                  # interactive TUI
agenc "summarize this repository"      # TUI with a first prompt
agenc --no-tui "run the tests and report failures"   # headless one-shot
agenc daemon status                    # the daemon owns sessions/agents
```

From here: `/help` inside the TUI lists slash commands; background agents run
via `agenc agent start <objective>`; sessions resume with `--continue` /
`--resume`.

## 5. Make it YOUR agent (Act 2)

```bash
agenc onboard identity     # name your agent: persona workspace + naming ritual
agenc onboard channel      # Telegram/Discord/Slack/WebChat, token checked live,
                           # pairing walkthrough ends with a reply on your phone
agenc gateway install-service   # keep the gateway always-on (systemd/launchd)
```

`identity` scaffolds `SOUL.md` / `USER.md` and runs a one-time naming ritual —
the agent chooses its own name and writes `IDENTITY.md`. Editing those files
IS the API. `channel` validates your bot token before anything persists,
stores it 0600 in `gateway/env`, and walks you through pairing: strangers who
find your bot get a code, not your agent.

## 6. Bounded autonomy (Act 3)

```bash
agenc onboard autonomy     # budget cap FIRST, then heartbeat, cron, webhooks
agenc onboard recap        # posture summary + things to try
```

The order is the design: nothing autonomous enables before a spend cap
exists. When a cap is hit, autonomy pauses and tells you — never silently
spends or silently stops. `agenc onboard --status` shows how far you are at
any time.

Coming from another assistant? See
[Migrate from OpenClaw](migrate-from-openclaw.md) and
[Migrate from Hermes](migrate-from-hermes.md).
