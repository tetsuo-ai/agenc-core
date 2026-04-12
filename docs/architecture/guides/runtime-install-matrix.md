# Runtime Install Matrix

This guide records the current supported install/runtime matrix for the AgenC
framework product as the public install path is stabilized.

It is intentionally conservative: if the repo does not validate a platform or
service mode today, this guide does not pretend it is supported.

## Canonical operator home

Current canonical local operator layout:

- config: `~/.agenc/config.json`
- PID: `~/.agenc/daemon.pid`
- replay SQLite store: `~/.agenc/replay-events.sqlite`
- logs/cache/plugin/connector data: `~/.agenc/`
- public runtime releases: `~/.agenc/runtime/releases/...`
- stable active runtime pointer: `~/.agenc/runtime/current`
- runtime install metadata: `~/.agenc/runtime/install-state.json`

Legacy `.agenc-runtime.json` is compatibility input only.

## Node runtime support

Current package engine floor from
[`runtime/package.json`](../../../runtime/package.json):

- Node `>=18.0.0`

Current support statement:

- Node `18+` is the minimum supported runtime floor for local CLI/daemon use
- the public `@tetsuo-ai/agenc` install path is currently validated in CI on:
  - Node `18` as the supported minimum floor
  - Node `20` as the current mainline release gate

## Public wrapper install support

The public `@tetsuo-ai/agenc` wrapper install path currently supports exactly
one validated tuple:

- Linux `x64`
- Node `>=18.0.0`

That support is enforced both in the wrapper and in the runtime-artifact build
pipeline, and the release gate now proves:

- fresh install
- wrapper-managed upgrade to a newer embedded runtime manifest
- `~/.agenc/runtime/current` convergence to the upgraded release

Other tuples must fail clearly as unsupported until explicit release coverage is
added.

Public first-use marketplace write rehearsal is only documented for that same
wrapper tuple. It assumes:

- Solana CLI installed separately from the wrapper
- funded devnet signer keypair(s)
- explicit devnet RPC configuration

See [public-wrapper-devnet-marketplace-rehearsal.md](public-wrapper-devnet-marketplace-rehearsal.md)
for the release-path runbook.

## Operating system support

### Linux

Status: supported for local CLI/daemon operation and for the public
`@tetsuo-ai/agenc` wrapper install path on `x64`.

Evidence in the current repo:

- daemon lifecycle/service install flow emits `systemd` units
- runtime command/docs assume POSIX process management and filesystem layout
- package smoke validates the public wrapper install path on Linux CI

### macOS

Status: supported for local CLI/daemon operation and for the public
`@tetsuo-ai/agenc` wrapper install path on Apple Silicon `arm64`.

Evidence in the current repo:

- service install flow emits `launchd` plists
- operator/runtime paths support standard macOS home-directory layout
- package smoke validates the public wrapper install path on macOS `arm64` CI

Still not claimed publicly:

- macOS `x64` / Intel wrapper install artifacts

### Windows

Status: not committed as a supported daemon/service-install target in Phase 1.

Reason:

- there is no Windows service-install contract in the current CLI
- lifecycle/docs are still written around POSIX + `systemd`/`launchd`

Windows compatibility can be improved later, but it should not be presented as
part of the first stable CLI/daemon contract yet.

## Service mode support

Supported today:

- foreground daemon
- background daemon with PID file
- Linux `systemd` service generation
- macOS `launchd` service generation

Not yet part of the stable public install contract:

- Windows service installation
- container/orchestrator-specific packaging as a first-class public path

## Optional dependency posture

The runtime includes optional capabilities and connectors whose transitive
dependencies are platform- or environment-sensitive, including:

- `better-sqlite3`
- `playwright`
- channel/connector packages such as Telegram and Slack-related integrations

Current contract:

- the base CLI/daemon flow must stay usable without every optional connector
  dependency enabled
- platform-specific connector failures must remain explicit feature gaps, not
  silent install corruption

## Telegram connector support

The first supported built-in connector in the public framework contract is
Telegram.

Current lifecycle contract:

- `agenc connector list`
- `agenc connector status telegram`
- `agenc connector add telegram --bot-token-env <ENV_NAME>`
- `agenc connector add telegram --bot-token-stdin`
- `agenc connector remove telegram`

Current behavior:

- Telegram runs inside the same daemon/gateway as the CLI, TUI, and dashboard
- polling is the default mode when no webhook config is provided
- webhook mode requires an explicit `channels.telegram.webhook.url`
- connector health and pending-restart state are exposed through the shared
  gateway status payload and rendered in both CLI and dashboard clients
- no extra npm package or post-install connector bundle step is required for
  the first-party Telegram connector

## Product-install implication

This matrix is the baseline for the public `@tetsuo-ai/agenc` install path and
the `agenc` CLI it installs:

- one daemon/gateway authority
- CLI + TUI + dashboard all attach to that same daemon
- dashboard HTTP path: `/ui/`
- `agenc ui` always hands the operator a loopback URL, even when the daemon
  binds `0.0.0.0`
- V1 dashboard auth contract:
  - no `auth.secret`, or
  - `auth.secret` with `auth.localBypass=true`
- canonical local state under `~/.agenc/`
- wrapper-managed runtime installs use the stable `~/.agenc/runtime/current`
  pointer

## Release channel

The production public wrapper contract is:

- npm package: `@tetsuo-ai/agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`
- trust: embedded signed manifest + embedded public key + embedded trust policy

Development and smoke tests may use local file manifests, but the production
install story should be described as GitHub Releases plus npm, not as a
private-registry or source-checkout workflow.

Any future packaged installer, wrapper package, or binary distribution must not
split operator state away from this canonical layout without an explicit ADR and
migration plan.
