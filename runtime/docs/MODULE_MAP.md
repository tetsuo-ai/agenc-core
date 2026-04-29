# Runtime Module Map

This file is the navigation guide for `runtime/src/`.

## Root Files

- `runtime.ts` - runtime lifecycle wrapper
- `index.ts` - package barrel
- `builder.ts` - runtime/program construction helpers
- `idl.ts` - protocol IDL loading helpers
- `project-doc.ts` - project-doc routing helpers
- `browser.ts` - browser-side support entrypoint
- `operator-events.ts` - operator-event export surface

## Module Families

### Operator and entry surfaces

- `bin/` - CLI entrypoints
- `cli/` - CLI implementation, including `marketplace-cli.ts` for `agenc-runtime market ...` and `marketplace-tui.ts` for `agenc-runtime market tui`
- `onboarding/` - operator bootstrap flow
- `desktop/` - desktop-side runtime support
- `watch/` - live watch and monitoring surfaces

### Core execution

- `agent/` - agent lifecycle manager
- `autonomous/` - autonomous execution flows
- `task/` - task operations
- `workflow/` - workflow orchestration
- `team/` - team-oriented execution support
- `tools/` - runtime tool registry and invocation support
- `skills/` - skill registry and lifecycle
- `plugins/` - plugin loading and host integration

### Connectivity and integration

- `connection/` - RPC/program connection wiring
- `channels/` - channel integrations, including dashboard `tools.*` and `market.*` transport handlers
- `bridges/` - cross-surface bridges
- `mcp-client/` - runtime-side MCP client integrations

### Model, memory, and evaluation

- `llm/` - model adapters and chat pipeline
- `eval/` - evaluation and replay-adjacent support
- `memory/` - memory backends and abstractions
- `policy/` - runtime policy enforcement
- `proof/` - proof generation and verification support
- `replay/` - replay and incident reconstruction support

### Protocol and marketplace

- `dispute/` - dispute operations
- `governance/` - governance support
- `marketplace/` - protocol marketplace serialization helpers used by the operator CLI, TUI, and web transport
- `reputation/` - reputation mechanics
- `social/` - social/feed surfaces

### Observability and support

- `events/` - event monitoring
- `observability/` - metrics and traces
- `telemetry/` - telemetry support
- `types/` - shared internal types
- `utils/` - shared helpers
- `voice/` - voice/audio support

## Use With

- [../../docs/CODEBASE_MAP.md](../../docs/CODEBASE_MAP.md) for repo-wide navigation
- [../../docs/RUNTIME_API.md](../../docs/RUNTIME_API.md) for runtime API details
- [./MARKETPLACE_OPERATOR_SURFACE.md](./MARKETPLACE_OPERATOR_SURFACE.md) for the MARKET/TOOLS split and terminal marketplace commands
- [../../docs/architecture/runtime-layers.md](../../docs/architecture/runtime-layers.md) for dependency layering
