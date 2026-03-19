# agenc

Public CLI and launcher for the AgenC framework.

This package owns the user-facing global install surface:

```bash
npm install -g @tetsuo-ai/agenc
agenc onboard
agenc start
agenc
agenc ui
```

`agenc onboard` is the canonical first-run path. It opens an interactive
terminal onboarding flow that:

- validates an xAI API key
- lets the operator shape the agent name, mission, role, soul, and tool posture
- writes the canonical config at `~/.agenc/config.json`
- generates the curated workspace markdown profile under `~/.agenc/workspace/`

It does not expose the runtime source tree directly. Instead, it installs and
launches the matching AgenC runtime artifact for the current supported
platform.

The supported npm install identity is `@tetsuo-ai/agenc`. The unscoped
`agenc` package name is not part of the supported public release contract.

Current public support is intentionally narrow:

- Linux `x64`
- Node `>=18.0.0`

Current validated release-gate lanes:

- Node `18` minimum floor
- Node `20` mainline lane

Production release channel:

- npm package: `@tetsuo-ai/agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`
- trust: embedded signed manifest + embedded public key + embedded trust policy

After the matching runtime artifact is installed, `agenc` can continue to run
offline against the local install. The npm package name is scoped, but the CLI
binary remains `agenc`.

`agenc` exposes two primary local operator surfaces against the same daemon:

- `agenc` attaches the terminal operator console
- `agenc ui` opens or prints the local dashboard URL on `/ui/`

For automation or remote shells, use:

```bash
agenc ui --no-open
```

## First-party connector lifecycle

The first V1 connector is Telegram. It is managed through the same daemon as the
CLI and dashboard; there is no separate connector service to start.

```bash
agenc connector list
agenc connector status telegram
agenc connector add telegram --bot-token-env TELEGRAM_BOT_TOKEN
agenc connector remove telegram
```

For non-interactive shells or secret managers, you can pipe the bot token on
stdin instead:

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" | agenc connector add telegram --bot-token-stdin
```

Connector health and pending-restart state are exposed through both:

- `agenc connector status telegram`
- `agenc ui` on the dashboard status view

## Wrapper-local runtime management

```bash
agenc runtime where
agenc runtime install
agenc runtime update
agenc runtime uninstall
```

## Development

The embedded runtime manifest in `generated/` is produced by the `agenc-core`
artifact preparation scripts. Local smoke tests use the same packaged manifest
flow as publish/release preparation.
