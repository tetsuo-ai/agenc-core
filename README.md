# agenc-core

Private AgenC engine repository.

This repository is the canonical owner of the private kernel:

- `runtime/`
- `mcp/`
- `docs-mcp/`
- `contracts/desktop-tool-contracts/`
- `containers/desktop/server/`
- `tools/localnet-social/`
- `tools/proof-harness/`

### Public Builder Entry Points

External builders should target:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol`
- `@tetsuo-ai/plugin-kit`

Private kernel packages remain internal implementation surfaces:

- `@tetsuo-ai/runtime` - Private kernel package; not a supported public builder API.
- `@tetsuo-ai/mcp` - Private kernel MCP package; not a public extension target.
- `@tetsuo-ai/docs-mcp` - Private kernel documentation package; not a supported public builder target.
- `@tetsuo-ai/desktop-tool-contracts` - Private kernel contract package; not a public plugin surface.

## Package Policy

Private kernel package policy:

- distribution mechanics: `docs/PRIVATE_KERNEL_DISTRIBUTION.md`
- support and deprecation policy: `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md`

## Development

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run test:cross-repo-integration
npm run check:private-kernel-surface
npm run check:private-kernel-distribution
npm run pack:smoke:skip-build
```

`npm run test` covers the core package/unit/default suites. The runtime LiteSVM
cross-repo contract tests are retained as `npm run test:cross-repo-integration`
because they depend on a protocol workspace fixture rather than the standalone
core package graph alone.

## Topology

- Public umbrella repo: `tetsuo-ai/AgenC`
- Public contract repos: `tetsuo-ai/agenc-sdk`, `tetsuo-ai/agenc-protocol`, `tetsuo-ai/agenc-plugin-kit`
- Private prover repo: `tetsuo-ai/agenc-prover`
- Private package registry: Cloudsmith `agenc/private-kernel`
