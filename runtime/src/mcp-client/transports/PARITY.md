# MCP Transport Parity

Upstream reference root: local CX runtime donor checkout at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:

- `rmcp-client/Cargo.toml`
- `rmcp-client/src/lib.rs`
- `rmcp-client/src/stdio_server_launcher.rs`
- `rmcp-client/src/program_resolver.rs`
- `rmcp-client/src/utils.rs`
- `rmcp-client/src/rmcp_client.rs`
- `rmcp-client/src/executor_process_transport.rs`
- `rmcp-client/tests/process_group_cleanup.rs`
- `rmcp-client/tests/resources.rs`
- `rmcp-client/tests/streamable_http_test_support.rs`

This directory owns the TypeScript port of MCP client transport setup:

- `stdio.ts` owns local stdio process launch, explicit environment assembly,
  line-delimited JSON-RPC framing, stderr diagnostics, and process-tree cleanup.
- `websocket.ts` owns JSON-RPC over WebSocket, header forwarding, message
  validation, and close/error propagation.
- `sse.ts` and `http.ts` remain the existing remote HTTP-family transports.
- `stdio.test.ts`, `websocket.test.ts`, and `connection.test.ts` cover
  transport dispatch, environment selection, stdio process cleanup, and
  WebSocket message/header behavior.

Remote executor-managed stdio from the donor is intentionally not carried here.
AgenC currently has no MCP executor-placement API in `runtime/src/mcp-client/`;
when that surface exists, it should be ported as a separate item with its own
process RPC contract.
