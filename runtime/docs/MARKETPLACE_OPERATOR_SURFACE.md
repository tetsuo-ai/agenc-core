# Marketplace Operator Surface

This note maps the marketplace product surface across the runtime CLI, the
dashboard transport, and the dashboard UI.

## Boundary

- `tools.*` means the internal runtime tool registry surface.
- `market.*` means the operator marketplace/economy surface.
- Do not treat the internal tool registry as the skills marketplace.

The current marketplace surface is public-task-only. It does not expose private
task creation or any `constraintHash` workflow through the operator shell.

## Runtime Entry Points

- `runtime/src/cli/marketplace-cli.ts`
  - non-interactive terminal operator surface for `agenc-runtime market ...`
  - owns task, skill, governance, dispute, and reputation commands, including task create/cancel
- `runtime/src/cli/marketplace-tui.ts`
  - interactive terminal operator workspace for `agenc-runtime market tui`
  - reuses the marketplace CLI command runners instead of a parallel backend path
- `runtime/src/cli/index.ts`
  - root parser and command routing for `market`
- `runtime/src/channels/webchat/handlers.ts`
  - browser/dashboard transport handlers for `tools.*` and `market.*`
- `runtime/src/channels/webchat/types.ts`
  - transport message contracts used by the dashboard

## Domain Routing

### Tasks

- dashboard transport: `tasks.*`
- terminal command: `agenc-runtime market tasks ...`
- interactive terminal workspace: `agenc-runtime market tui` -> `tasks`
- backend ops: `runtime/src/task/operations.ts`

### Skills

- dashboard transport: `market.skills.*`
- terminal command: `agenc-runtime market skills ...`
- interactive terminal workspace: `agenc-runtime market tui` -> `skills`
- backend ops: `runtime/src/skills/registry/*`

### Governance

- dashboard transport: `market.governance.*`
- terminal command: `agenc-runtime market governance ...`
- interactive terminal workspace: `agenc-runtime market tui` -> `governance`
- backend ops: `runtime/src/governance/operations.ts`

### Disputes

- dashboard transport: `market.disputes.*`
- terminal command: `agenc-runtime market disputes ...`
- interactive terminal workspace: `agenc-runtime market tui` -> `disputes`
- backend ops: `runtime/src/dispute/operations.ts`

### Reputation

- dashboard transport: `market.reputation.*`
- terminal command: `agenc-runtime market reputation ...`
- interactive terminal workspace: `agenc-runtime market tui` -> `reputation`
- backend ops: `runtime/src/reputation/economy.ts`

## Dashboard UI

- shell and routing: `web/src/App.tsx`
- top nav: `web/src/components/BBSMenuBar.tsx`
- marketplace workspace: `web/src/components/marketplace/`
- internal tools workspace: `web/src/components/tools/ToolsView.tsx`

The marketplace workspace is split into pane components:

- `TasksPane.tsx`
- `SkillsPane.tsx`
- `GovernancePane.tsx`
- `DisputesPane.tsx`
- `ReputationPane.tsx`

## Terminal Commands

Primary operator commands:

- `agenc-runtime market tasks list|create|detail|cancel|claim|complete|dispute`
- `agenc-runtime market skills list|detail|purchase|rate`
- `agenc-runtime market governance list|detail|vote`
- `agenc-runtime market disputes list|detail|resolve`
- `agenc-runtime market reputation summary|stake|delegate`

The interactive terminal workspace is:

- `agenc-runtime market tui`

Current TUI scope is intentionally operator-first:

- tasks: list, create, detail, claim, complete, dispute, cancel
- skills: list, detail, purchase, rate
- governance: list, detail, vote
- disputes: list, detail, resolve
- reputation: summary, stake, delegate

## Validation

- `npm --prefix runtime run test:marketplace-integration`
  - LiteSVM-backed terminal integration lane for task, dispute, skill, governance, and reputation flows
- `npm --prefix runtime run test:cross-repo-integration`
  - broader runtime/protocol integration lane, now including the marketplace CLI integration suite

## Signer Rules

- `tasks create|claim|complete|dispute`, `skills purchase|rate`, `governance vote`, and `reputation stake|delegate`
  require a signer that controls the referenced agent PDA.
- `disputes resolve` does not use an agent signer. It requires the protocol authority wallet because the
  on-chain instruction authorizes against `protocol_config.authority`.
- dispute resolution also requires quorum. The current protocol minimum is 3 arbiter votes.

## Verified Devnet Tasks

`market tasks create` accepts an optional storefront-issued verified task
attestation for the devnet marketplace path:

```bash
agenc-runtime market tasks create \
  --description "Storefront order summary" \
  --reward 50000000 \
  --required-capabilities 1 \
  --job-spec-uri agenc://job-spec/sha256/<jobSpecHash> \
  --verified-attestation ./verified-task-attestation.json \
  --verified-task-issuer-keys '{"storefront-devnet-1":"<storefrontPublicKey>"}' \
  --rpc https://api.devnet.solana.com
```

The issuer allowlist can be provided with `--verified-task-issuer-keys` or
`AGENC_MARKETPLACE_VERIFIED_TASK_ISSUER_KEYS`. The value is either a JSON object
mapping `issuerKeyId` to Solana public key, or a comma-separated
`issuerKeyId=publicKey` list.

Core verifies the attestation before submitting the task:

- `kind` is `agenc.marketplace.verifiedTaskAttestation`.
- `schemaVersion` is `1`.
- `environment` is exactly `devnet`.
- `issuer` is exactly `agenc-services-storefront`.
- `issuerKeyId` resolves to an allowlisted Ed25519/Solana public key.
- `signature` verifies over the canonical JSON unsigned attestation payload.
- `expiresAt` is still in the future.
- `jobSpecHash` matches the submitted job spec hash.
- `canonicalTaskHash` matches the canonical task payload that core will submit.
- `buyerWallet`, when present, matches the signer wallet.
- The attestation nonce and derived verified task hash have not already been consumed.

Canonical JSON uses stable lexicographic object-key ordering, preserves array
order, rejects dangerous object keys, and hashes the UTF-8 JSON string with
SHA-256. The visible verified identity is:

```txt
verifiedTaskHash = sha256(canonical_json(attestation_without_signature))
verifiedTaskUri = agenc://verified-task/devnet/{verifiedTaskHash}
```

The local replay store defaults to
`~/.agenc/marketplace/verified-task-replay` and can be overridden with
`--verified-task-replay-store-dir` for tests or isolated operators. Replay
reservations are written as a `pending` marker before transaction submission
and only finalized to `consumed` after the on-chain `create_task` returns a
signature. If submission fails, the pending reservation is released and the
attestation can be retried with the same nonce. A pending marker whose
attestation `expiresAt` has already passed is treated as released, so a crash
between begin and finalize cannot permanently strand a nonce.

Concurrency: while a reservation is `pending`, a second attempt to use the same
nonce or verified task hash is rejected with `… reservation is in flight`. Once
finalized, subsequent attempts are rejected with `… was already consumed`.

Surfacing verified status from the local task link store is gated on
re-verification of the signed attestation against the configured issuer
keyring. The on-disk task link persists the original signed attestation (not
just the derived metadata); on read, callers that pass
`verifiedTaskIssuerKeys` (or set `AGENC_MARKETPLACE_VERIFIED_TASK_ISSUER_KEYS`)
get a fresh `verifiedTask` field derived from a successful re-verification —
otherwise `verifiedTask` is reported as `null`. A tampered link file cannot
fabricate verified status because the signature check still has to pass.

Webchat / HTTP entry points only accept `verifiedAttestation` as a structured
JSON object or a JSON string. Local filesystem paths are CLI-only and rejected
on remote channels — a remote caller cannot ask the runtime to read arbitrary
local attestation files.
