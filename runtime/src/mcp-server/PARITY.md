# MCP Server Framework Parity

Donor reference: runtime snapshot at commit `35aaa5d9fcb606fb6f27dd5747ecab3f4ba0c07e`.

Primary source anchors:
- `mcp-server/src/lib.rs`
- `mcp-server/src/message_processor.rs`
- `mcp-server/src/outgoing_message.rs`

This directory owns AgenC's server-side MCP framework:
- `types.ts` defines transport-neutral JSON-RPC and MCP initialize/list shapes.
- `framework.ts` owns initialize/ping dispatch, lifecycle state, unsupported-method errors, server-originated request callbacks, notifications, and serialization.
- `tools.ts` maps AgenC tools into MCP tool definitions and delegates `tools/call` to the AgenC tool registry.
- `stdio.ts` owns server-side newline-delimited JSON-RPC over stdin/stdout streams.
- `index.ts` exports the subsystem surface for later MS-* transport and integration work.
