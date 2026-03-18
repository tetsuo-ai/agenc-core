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
- the package contract does not currently publish a narrower supported-LTS
  matrix than that engine floor
- when release CI pins exact Node versions for the public `agenc` install
  surface, this document should be updated to list those exact validated
  versions

## Public wrapper install support

The public `agenc` wrapper install path currently supports exactly one validated
tuple:

- Linux `x64`
- Node `>=18.0.0`

That support is enforced both in the wrapper and in the runtime-artifact build
pipeline. Other tuples must fail clearly as unsupported until explicit release
coverage is added.

## Operating system support

### Linux

Status: supported for local CLI/daemon operation and for the public `agenc`
wrapper install path on `x64`.

Evidence in the current repo:

- daemon lifecycle/service install flow emits `systemd` units
- runtime command/docs assume POSIX process management and filesystem layout
- package smoke validates the public wrapper install path on Linux CI

### macOS

Status: source/runtime development is plausible, but the public `agenc` wrapper
install path is **not yet** claimed as supported.

Evidence in the current repo:

- service install flow emits `launchd` plists
- operator/runtime paths support standard macOS home-directory layout

Why it is not yet claimed publicly:

- the public wrapper/runtime artifact flow is not validated on macOS release CI
- Phase 2 intentionally avoids overclaiming support beyond the tested release
  tuple

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

## Product-install implication

This matrix is the baseline for the public `agenc` install path:

- one daemon/gateway authority
- CLI + TUI + dashboard all attach to that same daemon
- canonical local state under `~/.agenc/`
- wrapper-managed runtime installs use the stable `~/.agenc/runtime/current`
  pointer

## Release channel

The production public wrapper contract is:

- npm package: `agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`
- trust: embedded signed manifest + embedded public key + embedded trust policy

Development and smoke tests may use local file manifests, but the production
install story should be described as GitHub Releases plus npm, not as a
private-registry or source-checkout workflow.

Any future packaged installer, wrapper package, or binary distribution must not
split operator state away from this canonical layout without an explicit ADR and
migration plan.
