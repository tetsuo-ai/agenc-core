# AgenC in 5 minutes

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

Coming from another assistant? See
[Migrate from OpenClaw](migrate-from-openclaw.md) and
[Migrate from Hermes](migrate-from-hermes.md).
