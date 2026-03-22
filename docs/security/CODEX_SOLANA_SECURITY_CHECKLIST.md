# Codex Solana Security Checklist

This checklist defines the minimum secure stack for Solana work in `agenc-core`,
with emphasis on non-ZK marketplace changes.

## Machine Setup

- Use the official Solana knowledge MCP in Codex:

```toml
[mcp_servers.solana-mcp]
url = "https://mcp.solana.com/mcp"
```

- Keep the Solana static-analysis MCP on devnet or localnet, not mainnet:

```toml
[mcp_servers.solana-fender]
command = "/home/tetsuo/.cargo/bin/anchor-mcp"
args = ["--mcp"]

[mcp_servers.solana-fender.env]
ANCHOR_PROVIDER_URL = "https://api.devnet.solana.com"
ANCHOR_WALLET = "/home/tetsuo/.config/solana/devnet-wallets/devnet-wallet-20260321-143652.json"
```

- Treat `solana-mcp` as read-only knowledge. Do not use it as a signer.
- Do not point Codex at a mainnet hot wallet.
- Restart Codex after changing `~/.codex/config.toml` so MCP registration reloads.

## Stack Roles

- `solana-mcp`: current Solana and Anchor documentation inside Codex.
- `solana-fender`: Solana/Anchor-specific static analysis.
- `semgrep`: general code-pattern and SAST coverage.
- `trivy`: dependency, secret, and config/misconfiguration checks.
- `gitguardian`: repository secret-leak detection.
- runtime LiteSVM and marketplace integration tests: transaction and operator-flow regression coverage.

No single layer is sufficient. The goal is overlapping controls:

- docs and API accuracy
- static analysis
- secret scanning
- dependency scanning
- transaction-flow regression tests
- devnet smoke rehearsal before release-sensitive changes

## Mandatory Gates For Non-ZK Marketplace Changes

Run these from `/home/tetsuo/git/AgenC/agenc-core`.

1. Runtime marketplace regression suite:

```bash
npm --prefix runtime run typecheck
npm --prefix runtime run test -- src/cli/index.test.ts src/cli/marketplace-tui.test.ts tests/cli-foundation.test.ts src/gateway/daemon.test.ts -t marketplace
npm --prefix runtime run test:marketplace-integration
```

2. Web marketplace regression suite:

```bash
npm --prefix web run typecheck
npm --prefix web run test -- App.integration.test.tsx src/hooks/useTasks.test.ts src/components/tasks/TaskCard.test.tsx src/components/marketplace/MarketplaceView.test.tsx
npm --prefix web run build
```

3. Security MCP healthcheck:

```bash
node scripts/check-security-mcp-stack.mjs --config mcp/security-stack.mcp.json --verbose
```

4. Solana Fender program scan plus baseline gate:

```bash
mkdir -p .tmp/security-mcp-sweep
node scripts/solana-fender-mcp.mjs check-program programs/agenc-coordination > .tmp/security-mcp-sweep/fender-program.txt
node scripts/check-fender-baseline.mjs --scan .tmp/security-mcp-sweep/fender-program.txt --baseline docs/security/fender-medium-baseline.json
```

5. Solana Fender full-repo scan plus baseline gate when runtime, MCP, or program boundaries changed:

```bash
node scripts/solana-fender-mcp.mjs check-program . > .tmp/security-mcp-sweep/fender-full.txt
node scripts/check-fender-baseline.mjs --scan .tmp/security-mcp-sweep/fender-full.txt --baseline docs/security/fender-full-baseline.json
```

6. GitGuardian MCP scan for repo secrets:

```bash
node scripts/gitguardian-mcp-scan.mjs --profile mcp/security-stack.mcp.json --scope . --output .tmp/security-mcp-sweep/gitguardian-mcp.json --fail-on-error
```

7. Devnet smoke when write flows, authority handling, or market CLI paths changed:

```bash
npm run smoke:marketplace:devnet
```

## Release-Sensitive Rules

- Use a separate devnet wallet for Codex and local testing.
- For production signing, move to `solana-keychain` or an HSM/KMS-backed signer surface instead of JSON keypairs.
- Hardcode or allowlist program IDs and token mint addresses per environment.
- Keep RPC endpoints out of frontend bundles.
- Re-verify authority assumptions for dispute resolution, cancellation, staking, and agent registration paths.
- Verify deployed programs against source before release or migration cutovers.

## When To Tighten Beyond This Baseline

- Mainnet deployment or treasury movement.
- New CPI paths.
- Token-2022 support.
- Wallet onboarding changes.
- Any new signer-bearing MCP or automation surface.

In those cases, add a live devnet rehearsal and an explicit human review of signer, account-owner, PDA, and mint-allowlist assumptions before merge.
