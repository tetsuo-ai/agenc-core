# Core Docs Index

This is the repo-level developer-documentation entrypoint for `agenc-core`.

## Start Here

- [../README.md](../README.md) - repo overview and product/install contract
- [./CODEBASE_MAP.md](./CODEBASE_MAP.md) - full repo map across workspaces, tools, tests, scripts, and docs
- [./COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md) - local validation and release-sensitive commands
- [../runtime/docs/MODULE_MAP.md](../runtime/docs/MODULE_MAP.md) - runtime module navigation guide
- [../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md](../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md) - MARKET/TOOLS split and runtime marketplace routing
- [../runtime/docs/compiled-job-phase1-launch-readiness.md](../runtime/docs/compiled-job-phase1-launch-readiness.md) - compiled marketplace Phase 1 runbook, retention posture, and launch checklist
- [./architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md](./architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md) - supported public-wrapper devnet marketplace rehearsal path
- [./architecture/README.md](./architecture/README.md) - architecture-focused reading path

## Primary Package Docs

- [../packages/agenc/README.md](../packages/agenc/README.md) - public CLI/launcher package
- [../runtime/README.md](../runtime/README.md) - runtime package entrypoint
- [../mcp/README.md](../mcp/README.md) - private MCP package
- [../docs-mcp/README.md](../docs-mcp/README.md) - documentation MCP package

## Local Surface Docs

- [../web/README.md](../web/README.md) - web dashboard surface
- [../mobile/README.md](../mobile/README.md) - mobile client surface
- [../containers/desktop/server/README.md](../containers/desktop/server/README.md) - desktop control server
- `../examples/*/README.md` - runtime-dependent internal examples
- [../test-fixtures/plugin-kit-channel-adapter/README.md](../test-fixtures/plugin-kit-channel-adapter/README.md) - plugin-kit fixture package
- [../tests/README.md](../tests/README.md) - root integration suites
- [../scripts/README.md](../scripts/README.md) - repo automation inventory

## Other Important Doc Groups

- `docs/architecture/` - ADRs, diagrams, flow docs, and implementation guides
- `docs/security/` - security guidance
- `docs/audit/` - audit artifacts
- `docs/design/` - design packages and deep dives
- `runtime/docs/` - runtime feature and operator docs

## Read By Task

- I need the repo layout: [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- I need runtime module ownership: [../runtime/docs/MODULE_MAP.md](../runtime/docs/MODULE_MAP.md)
- I need the MARKET/TOOLS split or terminal marketplace commands: [../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md](../runtime/docs/MARKETPLACE_OPERATOR_SURFACE.md)
- I need the compiled marketplace Phase 1 launch gates and runbook: [../runtime/docs/compiled-job-phase1-launch-readiness.md](../runtime/docs/compiled-job-phase1-launch-readiness.md)
- I need the public wrapper devnet rehearsal path: [architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md](./architecture/guides/public-wrapper-devnet-marketplace-rehearsal.md)
- I need build or CI commands: [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)
- I need runtime task-validation behavior: [RUNTIME_API.md](./RUNTIME_API.md) and [architecture/flows/task-lifecycle.md](./architecture/flows/task-lifecycle.md)
- I need the Codex Solana security stack and gate order: [security/CODEX_SOLANA_SECURITY_CHECKLIST.md](./security/CODEX_SOLANA_SECURITY_CHECKLIST.md)
- I need architecture context: [architecture/README.md](./architecture/README.md)
