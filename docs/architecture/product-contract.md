# AgenC Product Contract

This document defines the public product contract for AgenC after
[ADR-003](adr/adr-003-public-framework-product.md).

## Core statement

AgenC is an installable agent framework product with:

- a public CLI
- one local daemon/gateway as runtime authority
- a TUI/operator console
- a web dashboard using that same daemon
- plugin/connector/task/marketplace behavior through the same runtime

## Runtime authority

The daemon/gateway is the single local source of truth for:

- agent lifecycle
- session state
- health/status
- approvals
- logs and observability
- plugins and connectors
- jobs/tasks/bids

No client surface is allowed to create a second runtime authority.

## Client surfaces

### CLI

Primary responsibilities:

- onboarding
- lifecycle control: start/stop/restart/status/logs
- connector and plugin management
- eventual task/bid interaction

### TUI / operator console

Primary responsibilities:

- mature operator workflow
- advanced session/workspace/log/approval visibility
- deep local control

### Web dashboard

Primary responsibilities:

- health/status dashboard
- runs and observability
- approvals and configuration
- agent summary/control
- task and marketplace dashboards

The web dashboard is a daemon client, not a separate runtime.

## Public install surface

The public user-facing install identity is `agenc`.

V1 install flow:

```bash
npm install -g agenc
agenc onboard
agenc start
agenc
agenc ui
```

Phase 2 public wrapper support is intentionally narrow:

- platform: `linux`
- arch: `x64`
- Node: `>=18.0.0`

That tuple is the only one the public release/install contract should claim
until release CI validates more.

## Public package composition

The public `agenc` package is a wrapper/launcher package.

It does not depend on a private runtime package as a normal npm dependency.

V1 public package composition:

- `agenc-core` CI builds monolithic public runtime distributions from the
  existing runtime bins
- signed public runtime artifacts are published on GitHub Releases for
  `tetsuo-ai/agenc-core`
- the public `agenc` wrapper installs/updates/launches those runtime artifacts
- no end-user install path requires private-registry credentials

See [guides/public-runtime-release-channel.md](guides/public-runtime-release-channel.md)
for the explicit release-channel and trust model.

## Canonical local state

Canonical operator layout:

- config: `~/.agenc/config.json`
- PID: `~/.agenc/daemon.pid`
- logs/cache/plugin/connector state: `~/.agenc/`
- installed public runtime releases: `~/.agenc/runtime/releases/...`
- active runtime pointer: `~/.agenc/runtime/current`

Legacy `.agenc-runtime.json` is compatibility input only. It must not remain a
competing default.

## Dashboard choice

`web/` is the dashboard product surface.

`demo-app/` is not a peer dashboard. It is a separate demo-only surface that
must be moved out of the product path.

## Connector and plugin contract

Connectors and plugins must share one public host contract:

- `plugin_api_version`
- `host_api_version`

First-party connectors may ship built-in first, but they cannot create a second
incompatible lifecycle model.

## V1 scope

V1 means:

- install `agenc`
- onboard
- start/stop/status/logs
- TUI attach
- one daemon-backed web dashboard via `agenc ui`
- one first-party connector: Telegram

V1 does **not** require:

- voice/phone connector
- desktop packaging
- full marketplace UX polish

## Tracked implementation

This contract is being implemented in `tetsuo-ai/agenc-core` through:

- `#4` `feat(cli): converge agenc and agenc-runtime config/state defaults`
- `#5` `feat(distribution): ship public agenc wrapper package and runtime install path`
- `#6` `feat(web): lock agenc ui to the daemon-backed dashboard and retire demo-app from product surface`
- `#7` `feat(connectors): freeze plugin/connector host ABI and ship Telegram lifecycle`
- `#8` `feat(marketplace): define task/bid daemon contract before public marketplace UX`
- `#9` `chore(repo): build agenc-core declassification disposition table and scrub plan`

## Private service boundary

These may remain private:

- proving backends
- premium ranking/indexing/search/co-ordination
- anti-abuse/reputation
- admin/ops systems
- internal credentials and deployments

The local framework/runtime product itself is the public-facing product.
