# Core Codebase Map

This file maps the full `agenc-core` repo for developers and AI agents.

## Top-Level Layout

```text
agenc-core/
  packages/agenc/                    public CLI/launcher package
  runtime/                           private kernel package
  mcp/                               private MCP server package
  docs-mcp/                          documentation MCP package
  contracts/desktop-tool-contracts/  desktop contract package
  containers/desktop/server/         desktop control server
  containers/private-registry/       registry support container assets
  web/                               operator dashboard surface
  mobile/                            mobile client
  demo-app/                          demo UI
  examples/                          runtime-dependent internal examples
  tools/                             localnet and proof-harness tools
  test-fixtures/                     workspace fixtures
  tests/                             integration and mock-router suites
  scripts/                           boundary, distribution, and operator tooling
  config/                            private-kernel distribution configs
  docs/                              repo-level docs
```

## Workspace And Surface Map

### Public install and product shell

- `packages/agenc/` - `@tetsuo-ai/agenc` package, public install identity, and wrapper-local runtime management

### Private kernel packages

- `runtime/` - runtime authority, CLI bins, operator events, proof/task/watch/gateway logic, and the `agenc-runtime market ...` / `agenc-runtime market tui` operator surfaces
- `mcp/` - runtime-side MCP server and tool surfaces
- `docs-mcp/` - MCP server that indexes docs and contract artifacts

### Product clients and servers

- `web/` - operator dashboard with separate `MARKET` and `TOOLS` workspaces
- `mobile/` - mobile client
- `demo-app/` - demo UI
- `containers/desktop/server/` - desktop control server

Each of these surfaces now has a local `README.md` entrypoint.

### Examples, tools, and fixtures

- `examples/autonomous-agent/`
- `examples/dispute-arbiter/`
- `examples/event-dashboard/`
- `examples/llm-agent/`
- `examples/memory-agent/`
- `examples/skill-jupiter/`
- `tools/localnet-social/`
- `tools/proof-harness/`
- `test-fixtures/plugin-kit-channel-adapter/`

The example workspaces and the fixture package now have local `README.md`
docs as well.

### Non-workspace repo surfaces

- `tests/` - integration suites and mock-router support
- `scripts/` - boundary checks, distribution flows, asset sync, install smoke, and private registry tooling
- `config/` - private-kernel distribution configs
- `containers/private-registry/` - registry image/support assets

`tests/` and `scripts/` now have local `README.md` entry docs.

## Runtime Hotspots

The runtime package is the largest surface. Start with [../runtime/docs/MODULE_MAP.md](../runtime/docs/MODULE_MAP.md) for full navigation, then use [../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md](../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md) for the MARKET/TOOLS and terminal operator routing.

Dense runtime areas from the current codebase:

- `gateway/`
- `llm/`
- `eval/`
- `autonomous/`
- `watch/`
- `task/`

## Workflows

Repo workflows under `.github/workflows/` include:

- `package-pack-smoke.yml`
- `private-kernel-cloudsmith.yml`
- `private-kernel-registry.yml`
- `proof-harness-boundary.yml`

## Ownership Boundaries

- Public SDK changes belong in `agenc-sdk`.
- Public protocol changes belong in `agenc-protocol`.
- Public plugin ABI changes belong in `agenc-plugin-kit`.
- Proving server and private admin changes belong in `agenc-prover`.

This repo owns the framework/runtime/product implementation side of AgenC.
