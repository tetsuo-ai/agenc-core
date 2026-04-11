# AgenC Architecture Documentation

Architecture reference for AgenC protocol and runtime surfaces. These docs are implementation reference, not the whole-repository planning authority.

For whole-repo navigation, start with [../CODEBASE_MAP.md](../CODEBASE_MAP.md) and [../DOCS_INDEX.md](../DOCS_INDEX.md).

## How to Use

- **Understanding the current product contract?** Start with [product-contract.md](product-contract.md) and [adr/adr-003-public-framework-product.md](adr/adr-003-public-framework-product.md)
- **Understanding the tracked rollout for that contract?** See [product-contract.md](product-contract.md) plus the active implementation issues in `tetsuo-ai/agenc-core`
- **Understanding the system?** Read `overview.md` then `runtime-layers.md`
- **Writing new code?** Check `guides/` for conventions and templates
- **Debugging a flow?** See the sequence diagrams in `flows/`

## Table of Contents

### System Architecture

| Document | Description |
|----------|-------------|
| [overview.md](overview.md) | System component diagram — 5 packages and their relationships |
| [product-contract.md](product-contract.md) | Public product contract: one daemon, shared TUI/web surfaces, and public install path |
| [runtime-layers.md](runtime-layers.md) | 7-layer module dependency diagram for the runtime |
| [interfaces.md](interfaces.md) | Class diagrams for 10 key interfaces |

### Architecture Decisions

| Document | Description |
|----------|-------------|
| [adr/adr-001-durable-task-runtime.md](adr/adr-001-durable-task-runtime.md) | Canonical durable task runtime contract, lifecycle semantics, and invariants |
| [adr/adr-003-public-framework-product.md](adr/adr-003-public-framework-product.md) | Current direction: public framework product, shared daemon, and staged declassification |

### Flow Diagrams

| Document | Description |
|----------|-------------|
| [flows/task-lifecycle.md](flows/task-lifecycle.md) | create → claim → complete/cancel sequence |
| [flows/dispute-resolution.md](flows/dispute-resolution.md) | initiate → vote → resolve/slash sequence |
| [flows/agent-registration.md](flows/agent-registration.md) | register → activate → deregister state machine |
| [flows/autonomous-execution.md](flows/autonomous-execution.md) | scan → discover → execute → verify → proof |
| [flows/workflow-execution.md](flows/workflow-execution.md) | compile → sort → submit → monitor |
| [flows/zk-proof-flow.md](flows/zk-proof-flow.md) | generate → cache → submit → verify |
| [flows/speculative-execution.md](flows/speculative-execution.md) | commit → speculate → defer → rollback |
| [flows/runtime-chat-pipeline.md](flows/runtime-chat-pipeline.md) | prompt assembly → tool loop → fallback/retry → stop reasons |
| [flows/subagent-orchestration.md](flows/subagent-orchestration.md) | planner DAG delegation → child orchestration → verifier/synthesis |

### Implementation Guides

| Document | Description |
|----------|-------------|
| [guides/cli-runtime-migration-map.md](guides/cli-runtime-migration-map.md) | Current `agenc` / `agenc-runtime` surface mapping into the public product contract |
| [guides/public-runtime-release-channel.md](guides/public-runtime-release-channel.md) | Public `agenc` wrapper release channel, trust model, and runtime artifact contract |
| [guides/public-wrapper-devnet-marketplace-rehearsal.md](guides/public-wrapper-devnet-marketplace-rehearsal.md) | Supported first-use devnet marketplace rehearsal from the public `agenc` wrapper path |
| [guides/runtime-install-matrix.md](guides/runtime-install-matrix.md) | Current Node/OS/service-mode support and canonical local operator state layout |
| [guides/runtime-completion-semantics.md](guides/runtime-completion-semantics.md) | Final completion-state rules, implementation verifier authority, and the only allowed legacy compatibility classes |
| [guides/delegated-workspace-semantics.md](guides/delegated-workspace-semantics.md) | Canonical delegated local-file scope, `/workspace` presentation-only rules, shared-artifact denial, and preflight debugging |
| [guides/new-module-template.md](guides/new-module-template.md) | Standard module structure, error codes, barrel exports |
| [guides/type-conventions.md](guides/type-conventions.md) | bigint vs BN, Uint8Array vs Buffer, etc. |
| [guides/testing-patterns.md](guides/testing-patterns.md) | Mock patterns, vitest setup, LiteSVM |
| [guides/error-handling.md](guides/error-handling.md) | RuntimeErrorCodes, error class patterns |
| [guides/integration-points.md](guides/integration-points.md) | Cross-module wiring, builder, telemetry |

## Docs MCP Server

An MCP server at `docs-mcp/` serves this documentation to AI agents:

```bash
claude mcp add agenc-docs -- node docs-mcp/dist/index.js
```

Current tools: `docs_search`, `docs_get_module_template`, `docs_get_module_info`, `docs_get_conventions`

`docs_search` plus the indexed docs/resources are the primary access path. The remaining helper tools are runtime-scoped and are not authoritative for whole-repository planning.
