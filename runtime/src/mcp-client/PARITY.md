# MCP Client Parity

Donor reference: runtime snapshot at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `core/src/mcp_tool_call.rs`
- `core/src/session/mod.rs`
- `core/src/mcp_tool_approval_templates.rs`

This directory owns AgenC's external MCP client bridge:
- `tool-bridge.ts` adapts external MCP server tools into AgenC tools and, for MS-05, gates their execution through permission arbitration, approval prompts, MCP approval templates, and request-permissions RPC handling.
- `manager.ts` carries session-provided bridge permissions into every connected server bridge.
- `resilient-bridge.ts` preserves the same bridge permission wiring after reconnects.
