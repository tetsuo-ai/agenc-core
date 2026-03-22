# Core Commands And Validation

This file maps the local validation surface for `agenc-core`.

## Core Repo Commands

```bash
npm install
npm run build
npm run typecheck
npm run test
npm --prefix runtime run test:marketplace-integration
npm run test:cross-repo-integration
npm run build:product-surfaces
npm run typecheck:product-surfaces
npm run test:product-surfaces
npm run typecheck:runtime-examples
npm run check:private-kernel-surface
npm run check:private-kernel-distribution
npm run check:proof-harness-boundary
npm run pack:smoke:skip-build
```

## When To Run What

- runtime, MCP, or docs-mcp change: `npm run build`, `npm run typecheck`, `npm run test`
- cross-repo runtime/protocol contract change: `npm run test:cross-repo-integration`
- terminal marketplace flow change: `npm --prefix runtime run test:marketplace-integration`
- dashboard, mobile, or demo-app change: `npm run build:product-surfaces`, `npm run typecheck:product-surfaces`, `npm run test:product-surfaces`
- internal example change: `npm run typecheck:runtime-examples`
- packaging or distribution change: `npm run check:private-kernel-distribution` and `npm run pack:smoke:skip-build`
- proof-harness surface change: `npm run check:proof-harness-boundary`

## Marketplace Operator Surface

When changing the MARKET/TOOLS shell split or `agenc-runtime market ...`:

```bash
npm --prefix runtime run typecheck
npm --prefix runtime run test -- src/cli/index.test.ts src/cli/marketplace-tui.test.ts tests/cli-foundation.test.ts
npm --prefix runtime run test:marketplace-integration
npm --prefix web run typecheck
npm --prefix web run test -- App.integration.test.tsx useTasks.test.ts TaskCard.test.tsx src/components/marketplace/MarketplaceView.test.tsx
npm --prefix web run build
```

Operator invariants that matter in practice:

- `agenc-runtime market disputes resolve` must run with the protocol authority keypair, not a creator/worker agent keypair.
- dispute resolution requires at least 3 arbiter votes under the current on-chain rules.

Useful manual smoke commands:

```bash
agenc-runtime market tui --rpc <url>
agenc-runtime market tasks create --description "public task" --reward 50000000 --rpc <url>
agenc-runtime market tasks list --rpc <url>
agenc-runtime market tasks cancel <taskPda> --rpc <url>
agenc-runtime market skills list --rpc <url>
agenc-runtime market governance list --rpc <url>
agenc-runtime market disputes list --rpc <url>
agenc-runtime market reputation summary --rpc <url>
```

## Solana Security Sweep

For Codex-assisted Solana work, especially non-ZK marketplace changes, use the
repo-local checklist in `docs/security/CODEX_SOLANA_SECURITY_CHECKLIST.md`.

The minimum security stack is:

- official `solana-mcp` for documentation and API lookups
- `solana-fender` for Solana-specific static analysis
- `mcp/security-stack.mcp.json` for Semgrep, Trivy, GitGuardian, and Fender probes

Useful commands:

```bash
node scripts/check-security-mcp-stack.mjs --config mcp/security-stack.mcp.json --verbose
node scripts/solana-fender-mcp.mjs check-program programs/agenc-coordination
node scripts/gitguardian-mcp-scan.mjs --profile mcp/security-stack.mcp.json --scope . --output .tmp/security-mcp-sweep/gitguardian-mcp.json --fail-on-error
npm run smoke:marketplace:devnet
```

## Private Registry And Distribution

Useful distribution and registry commands include:

- `npm run private-registry:up`
- `npm run private-registry:down`
- `npm run private-registry:health`
- `npm run private-registry:rehearse`
- `npm run stage:private-kernel-distribution`
- `npm run dry-run:private-kernel-distribution`

Use the package policy docs in `docs/PRIVATE_KERNEL_DISTRIBUTION.md` and `docs/PRIVATE_KERNEL_SUPPORT_POLICY.md` for policy, not this command index.
