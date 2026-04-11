# agenc-core

Canonical public implementation repository for the AgenC framework product.

## Start Here

- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) - repo-level reading order
- [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) - full repo map across workspaces, tools, tests, scripts, and docs
- [docs/COMMANDS_AND_VALIDATION.md](docs/COMMANDS_AND_VALIDATION.md) - validation and release-sensitive commands
- [runtime/docs/MODULE_MAP.md](runtime/docs/MODULE_MAP.md) - runtime module navigation guide
- [docs/architecture/README.md](docs/architecture/README.md) - architecture-focused reading path

This repository currently owns the implementation for:

- `packages/agenc/`
- `runtime/`
- `mcp/`
- `docs-mcp/`
- `contracts/desktop-tool-contracts/`
- `containers/desktop/server/`
- `containers/private-registry/`
- `web/`
- `mobile/`
- runtime-dependent internal examples
- `tools/localnet-social/`
- `tools/proof-harness/`
- `test-fixtures/plugin-kit-channel-adapter/`
- `tests/`
- `scripts/`
- `config/`

Under [ADR-003](docs/architecture/adr/adr-003-public-framework-product.md), the
product contract is public-framework-first:

- the npm install surface is `@tetsuo-ai/agenc`
- the CLI command remains `agenc`
- one daemon/gateway is the runtime authority
- TUI and web are sibling clients of that daemon

Current public operator routing inside that daemon-backed surface is:

- `agenc agent register` to register the signer wallet as an on-chain agent
- `agenc market ...` for non-interactive terminal marketplace flows
- `agenc market tui` for the interactive terminal marketplace workspace
- dashboard `MARKET` for tasks, skills, governance, disputes, and reputation
- dashboard `TOOLS` for the internal runtime tool registry
- `agenc-runtime ...` remains a compatibility alias after runtime install, but the public release-path docs should use `agenc ...`

### Public Builder Entry Points

External builders should target:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol`
- `@tetsuo-ai/plugin-kit`

Implementation packages in this repo remain non-builder surfaces:

- `@tetsuo-ai/runtime` - Private kernel package; not a supported public builder API.
- `@tetsuo-ai/mcp` - Private kernel MCP package; not a public extension target.
- `@tetsuo-ai/docs-mcp` - Private kernel documentation package; not a supported public builder target.
- `@tetsuo-ai/desktop-tool-contracts` - Private kernel contract package; not a public plugin surface.

### Public Product Install Surface

The public operator install identity is the scoped package `@tetsuo-ai/agenc`,
which installs the `agenc` CLI.

Phase 2 public wrapper support is currently:

- Linux `x64`
- Node `>=18.0.0`

See:

- [docs/architecture/product-contract.md](docs/architecture/product-contract.md)
- [docs/architecture/guides/public-runtime-release-channel.md](docs/architecture/guides/public-runtime-release-channel.md)
- [docs/architecture/guides/runtime-install-matrix.md](docs/architecture/guides/runtime-install-matrix.md)
- [docs/architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md](docs/architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md)

## Package Policy

Internal package/service policy:

- distribution mechanics: `docs/PRIVATE_KERNEL_DISTRIBUTION.md`
- support and deprecation policy: `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md`

## Repo Layout

```text
agenc-core/
  packages/agenc/
  runtime/
  mcp/
  docs-mcp/
  contracts/desktop-tool-contracts/
  containers/desktop/server/
  containers/private-registry/
  web/
  mobile/
  examples/
  tools/
  test-fixtures/
  tests/
  scripts/
  config/
  docs/
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run test:cross-repo-integration
npm run build:product-surfaces
npm run typecheck:product-surfaces
npm run test:product-surfaces
npm run typecheck:runtime-examples
npm run check:private-kernel-surface
npm run check:private-kernel-distribution
npm run pack:smoke:skip-build
```

`npm run test` covers the core package/unit/default suites. The runtime LiteSVM
cross-repo contract tests are retained as `npm run test:cross-repo-integration`
because they depend on a protocol workspace fixture rather than the standalone
core package graph alone.

Private product surfaces and runtime-dependent examples now have explicit
non-default validation entrypoints so they can be brought into `agenc-core`
without silently widening the kernel package build closure in one step.

The internal runtime-dependent examples are validated via TypeScript-only
workspace contracts rather than by executing their `tsx` entrypoints, because
those entrypoints are designed to perform real network/runtime flows.

## Topology

- Public umbrella repo: `tetsuo-ai/AgenC`
- Public framework repo: `tetsuo-ai/agenc-core`
- Public contract repos: `tetsuo-ai/agenc-sdk`, `tetsuo-ai/agenc-protocol`, `tetsuo-ai/agenc-plugin-kit`
- Private prover repo: `tetsuo-ai/agenc-prover`
- Private package registry: Cloudsmith `agenc/private-kernel`
