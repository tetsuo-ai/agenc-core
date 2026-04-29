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
