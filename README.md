# agenc-core

Canonical public implementation repository for the AgenC framework product.

This repository currently owns the implementation for:

- `runtime/`
- `mcp/`
- `docs-mcp/`
- `contracts/desktop-tool-contracts/`
- `containers/desktop/server/`
- `web/`
- `mobile/`
- `demo-app/`
- runtime-dependent internal examples
- `tools/localnet-social/`
- `tools/proof-harness/`

Under [ADR-003](docs/architecture/adr/adr-003-public-framework-product.md), the
product contract is public-framework-first:

- the install surface is `agenc`
- one daemon/gateway is the runtime authority
- TUI and web are sibling clients of that daemon

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

The public operator install identity is `agenc`.

Phase 2 public wrapper support is currently:

- Linux `x64`
- Node `>=18.0.0`

See:

- [docs/architecture/product-contract.md](docs/architecture/product-contract.md)
- [docs/architecture/guides/public-runtime-release-channel.md](docs/architecture/guides/public-runtime-release-channel.md)
- [docs/architecture/guides/runtime-install-matrix.md](docs/architecture/guides/runtime-install-matrix.md)

## Package Policy

Internal package/service policy:

- distribution mechanics: `docs/PRIVATE_KERNEL_DISTRIBUTION.md`
- support and deprecation policy: `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md`

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
