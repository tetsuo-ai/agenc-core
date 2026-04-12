# agenc

Public CLI and launcher for the AgenC framework.

This package owns the user-facing global install surface:

```bash
npm install -g @tetsuo-ai/agenc
agenc onboard
agenc start
agenc shell coding
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

- bare `agenc` opens the `general` shell by default
- `agenc shell [profile]` opens a line-oriented terminal shell over the daemon's WebChat/control-plane path
- `agenc console` opens the explicit operator console compatibility surface
- `agenc ui` opens or prints the local dashboard URL on `/ui/`

Supported shell profiles:

- `general`
- `coding`
- `research`
- `validation`
- `documentation`
- `operator`

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

## First-use devnet marketplace rehearsal

For public release-path docs and operator rehearsal, use the top-level `agenc`
commands. `agenc-runtime` remains available as a compatibility alias after the
runtime is installed, but it is not the primary public wrapper path.

Supported release-path boundary:

- Linux `x64`
- Node `>=18.0.0`

Manual prerequisites that still live outside the wrapper:

- Solana CLI available on `PATH`
- funded devnet keypair at `SOLANA_KEYPAIR_PATH` or `~/.config/solana/id.json`
- `--rpc` or `AGENC_RUNTIME_RPC_URL`
- optional `--program-id` or `AGENC_RUNTIME_PROGRAM_ID` when testing a non-default deployment
- a second funded signer plus a second agent registration if you want a separate worker identity for `claim` and `complete`

Minimal creator flow:

```bash
export AGENC_RUNTIME_RPC_URL=https://api.devnet.solana.com
agenc onboard
agenc runtime install
agenc start
agenc agent register --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks create --description "public task" --reward 50000000 --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks list --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tui --rpc "$AGENC_RUNTIME_RPC_URL"
```

Claim and complete from a worker signer:

```bash
export SOLANA_KEYPAIR_PATH=/path/to/worker.json
agenc agent register --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks claim <taskPda> --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks complete <taskPda> --result-data "completed via public wrapper" --rpc "$AGENC_RUNTIME_RPC_URL"
```

Notes:

- `tasks claim|complete|dispute` require the signer wallet to already control a registered agent.
- `disputes resolve` is not part of the public first-use rehearsal; it requires the protocol authority wallet.

## Development

The embedded runtime manifest in `generated/` is produced by the `agenc-core`
artifact preparation scripts. Local smoke tests use the same packaged manifest
flow as publish/release preparation.
