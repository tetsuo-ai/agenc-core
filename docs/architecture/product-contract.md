# AgenC Product Contract

This document defines the public product contract for AgenC after
[ADR-003](adr/adr-003-public-framework-product.md).

## Core statement

AgenC is an installable agent framework product with:

- a public CLI
- one local daemon/gateway as runtime authority
- shell profiles on that same runtime authority
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
- shell entrypoints such as bare `agenc` and `agenc shell coding`
- connector and plugin management
- eventual task/bid interaction

Shell profiles are a client/runtime contract, not a separate product fork.
Current supported profiles:

- `general`
- `coding`
- `research`
- `validation`
- `documentation`
- `operator`

All profiles share the same daemon, policy authority, approvals, memory, and
tooling substrate. Profiles only change default behavior such as prompt rules,
tool advertisement bias, delegation posture, and session identity.

The `coding` profile now has a native coding tool surface on that shared
runtime. It is expected to expose:

- repo inventory and file search
- structured git and worktree inspection/mutation tools
- safe read-range and patch-application tools
- native tool discovery for mixed-mode expansion
- native code-intelligence lookups for definitions and references

V1 connector contract:

- `agenc connector list`
- `agenc connector status telegram`
- `agenc connector add telegram`
- `agenc connector remove telegram`

### TUI / operator console

Primary responsibilities:

- mature operator workflow
- advanced session/workspace/log/approval visibility
- deep local control

The operator console is now an explicit compatibility surface behind
`agenc console`; the default public interactive surface is the shell-first
launcher.

### Web dashboard

Primary responsibilities:

- health/status dashboard
- runs and observability
- approvals and configuration
- agent summary/control
- connector health and restart visibility
- task and marketplace dashboards

The web dashboard is a daemon client, not a separate runtime.

## Public install surface

The public user-facing install identity is the scoped npm package
`@tetsuo-ai/agenc`, which installs the `agenc` CLI command.

The unscoped `agenc` package name is not part of the supported public install
contract.

V1 install flow:

```bash
npm install -g @tetsuo-ai/agenc
agenc onboard
agenc
agenc ui
```

`agenc`, `agenc console`, and `agenc ui` all target the same local daemon.
Bare `agenc` opens the `general` shell by default. `agenc ui` is not a second
runtime; it is a loopback dashboard surface mounted at `/ui/` on the daemon
HTTP port.

`agenc onboard` is the canonical first-run experience. In V1 it is an
interactive terminal onboarding flow that validates xAI access, collects the
core agent identity/soul posture, writes `~/.agenc/config.json`, and generates
the curated workspace markdown profile under `~/.agenc/workspace/`.

Phase 2 public wrapper support is intentionally narrow:

- platform: `linux`
- arch: `x64`
- Node: `>=18.0.0`

That tuple is the only one the public release/install contract should claim
until release CI validates more. Current CI validates it on Node `18` as the
minimum floor and Node `20` as the mainline lane.

## Public package composition

The public `@tetsuo-ai/agenc` package is a wrapper/launcher package.

It does not depend on a private runtime package as a normal npm dependency.

V1 public package composition:

- `agenc-core` CI builds monolithic public runtime distributions from the
  existing runtime bins
- signed public runtime artifacts are published on GitHub Releases for
  `tetsuo-ai/agenc-core`
- the public `@tetsuo-ai/agenc` wrapper installs/updates/launches those runtime artifacts
- no end-user install path requires private-registry credentials

See [guides/public-runtime-release-channel.md](guides/public-runtime-release-channel.md)
for the explicit release-channel and trust model.

Release hardening requires proof of:

- fresh install
- wrapper-package upgrade to a newer embedded runtime manifest
- stable `~/.agenc/runtime/current` handoff after upgrade

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

`demo-app/` was not a peer dashboard. It has been retired per ADR-003.

## Connector and plugin contract

Connectors and plugins must share one public host contract:

- `plugin_api_version`
- `host_api_version`

First-party connectors may ship built-in first, but they cannot create a second
incompatible lifecycle model.

## V1 scope

V1 means:

- install `@tetsuo-ai/agenc`
- onboard
- start/stop/status/logs
- TUI attach
- one daemon-backed web dashboard via `agenc ui`
- `agenc ui --no-open` support for SSH/automation/manual browser handoff
- one first-party connector: Telegram
- Telegram connector lifecycle through the same daemon:
  - list
  - status
  - add/configure
  - remove
- shared connector state/health visible in both CLI and dashboard

V1 does **not** require:

- voice/phone connector
- desktop packaging
- full marketplace UX polish

## Tracked implementation

This contract is being implemented in `tetsuo-ai/agenc-core` through:

- `#4` `feat(cli): converge agenc and agenc-runtime config/state defaults`
- `#5` `feat(distribution): ship public agenc wrapper package and runtime install path`
- `#6` `feat(web): lock agenc ui to the daemon-backed dashboard and retire demo-app from product surface` (demo-app removed)
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
