# ADR-003: Public Framework Product And Shared-Daemon Surfaces

- **Status:** Accepted
- **Date:** 2026-03-18
- **Owners:** Product / Runtime Architecture

## Context

The earlier private-boundary direction solved a real problem: the repo had public-contract surfaces and a
still-public runtime posture at the same time, which made the intended
public/private split incoherent.

That decision produced a clean boundary:

- SDK, protocol, and plugin-kit were the public surfaces
- the kernel/runtime stayed private
- private-kernel CI/docs/package policy enforced that boundary

That boundary was internally coherent, but it conflicts with what AgenC is
supposed to be as a product.

The current codebase already behaves much more like an installable agent
framework:

- a local daemon/gateway is the runtime authority
- `agenc` already defaults to the operator console and forwards other commands
  to the runtime CLI
- the TUI/watch surface is the more mature operator client
- the web app already speaks the same runtime websocket/browser protocol rather
  than a separate backend model
- task, bid, marketplace, plugin, and connector behaviors belong to the product
  itself

The product requirement is therefore:

- users should be able to install AgenC
- run a local daemon/runtime
- use the TUI and a web dashboard against that same daemon
- connect channels/connectors
- participate in task and bid flows

Trying to preserve a permanently private local framework fights that product
reality. Source privacy is not the right primary moat for a local-first agent
framework. Product quality, ecosystem, marketplace participation, operational
advantage, and premium network services are.

## Decision

### Product direction

AgenC is a public framework product.

The end state is:

- installable public `@tetsuo-ai/agenc` package with the `agenc` CLI
- one local daemon/gateway as runtime authority
- TUI/operator console and web UI as sibling clients of the same daemon
- public plugin/add-on model around the same daemon/runtime
- public marketplace participation flows in the product surface

### Shared-daemon rule

There is exactly one local runtime authority: the daemon/gateway.

It owns:

- sessions
- health/status
- logs
- approvals
- plugins
- connectors
- jobs/tasks
- bids/marketplace state
- UI-facing observability state

TUI, CLI lifecycle commands, and the web dashboard all operate that same daemon.

### Web UI rule

The web UI is a dashboard/control center over the daemon.

It is **not** a second runtime, **not** a second state authority, and **not** a
forked product brain.

For the public product path:

- `web/` is the dashboard surface
- `demo-app/` is not a peer dashboard candidate (retired)

### Package/install rule

The public install identity is the scoped npm package `@tetsuo-ai/agenc`,
which installs the `agenc` CLI.

`@tetsuo-ai/agenc` is a public wrapper/launcher package around the runtime
surface. It is not a hand-waved public rename of the current
private/transitional runtime package.

`@tetsuo-ai/runtime` may remain transitional/internal while the installable
public product surface is stabilized.

### Connector/plugin rule

There must not be two connector models.

The versioned public host ABI must be frozen before connector shipping:

- `plugin_api_version`
- `host_api_version`

First-party connectors may ship built-in first, but they still align to the
same public plugin/connector host model rather than inventing a second
incompatible lifecycle.

### Private boundary after this ADR

Private code is limited to genuine service-side or operational advantage:

- proving backends
- premium ranking/indexing/search/co-ordination services
- anti-abuse/reputation services
- admin/ops tooling
- internal service credentials and deployments

### Transition rule

This ADR supersedes ADR-002 as the architectural direction, but the repo is not
considered declassified just because this ADR exists.

Implementation must proceed in two stages:

1. make the public product install path, shared-daemon model, and package
   contract real
2. perform a declassification/public-scrub program before flipping
   `agenc-core` visibility or removing private-boundary CI/policy

Until that scrub is complete, old private-boundary checks remain transitional
enforcement, not proof that ADR-003 is invalid.

## Consequences

### Positive

- product direction now matches what AgenC actually is
- OpenClaw-style shared-daemon operation becomes the explicit target
- TUI and web can evolve as coherent clients instead of separate products
- the framework becomes easier to install and adopt
- marketplace participation is treated as first-class product behavior

### Tradeoffs

- the old private-kernel posture must be unwound carefully rather than ignored
- package/install strategy must be explicit because public `@tetsuo-ai/agenc`
  cannot simply depend on a private runtime package
- declassification is now a real tracked implementation phase, not a future
  hand-wave
- source visibility is no longer the primary moat assumption

## Implementation status

Accepted direction. Not yet fully implemented.

Required implementation gates:

1. Phase 0: product contract + command/config/package strategy lock
2. Phase 1: command/config convergence and compatibility handling
3. Phase 2: public `@tetsuo-ai/agenc` install path
4. Phase 3: daemon-backed web dashboard via `agenc ui`
5. Later: task/bid contract, marketplace UX, connector expansion
6. Final: public-scrub/declassification program for `agenc-core`

Tracked implementation issues in `tetsuo-ai/agenc-core`:

- `#4` CLI/config convergence
- `#5` public `@tetsuo-ai/agenc` wrapper and runtime install path
- `#6` daemon-backed web dashboard and `demo-app` retirement from product path (demo-app removed)
- `#7` connector/plugin ABI freeze plus Telegram lifecycle
- `#8` task/bid daemon contract before marketplace UX
- `#9` declassification disposition table and scrub plan
