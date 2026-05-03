# Elicitation Parity

Upstream reference: donor runtime snapshot at commit `35aaa5d9fcb606fb6f27dd5747ecab3f4ba0c07e`.

Primary source anchors:
- `donor-runtime/protocol/src/request_user_input.rs`
- `donor-runtime/tools/src/request_user_input_tool.rs`
- `donor-mcp/elicitation.rs`
- `donor-mcp-client/elicitation_client_service.rs`
- `donor-runtime/core/src/tools/handlers/request_user_input.rs`
- `donor-runtime/core/src/session/mod.rs`
- `donor-runtime/core/src/state/turn.rs`

This directory owns the TypeScript port of the mid-turn user-input and MCP elicitation substrate:
- `types.ts` defines shared request, response, and event shapes.
- `request-user-input.ts` implements the model-facing tool schema, mode gate, normalization, and session call boundary.
- `mcp.ts` implements MCP request normalization, policy handling, SDK handler registration, and session call boundary.
- `respond.ts` validates client responses and forwards them to the live session pending maps.
- `url-completion.ts` marks URL completion notifications that should clear local TUI prompts without sending duplicate daemon responses.
- `index.ts` re-exports the subsystem surface.
