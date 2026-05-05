# Request Permissions RPC Parity

Upstream reference root: `/home/tetsuo/git/codex/codex-rs`
Upstream reference commit: `c8c30d9d75556ecbe94991af22380d2a4e9d6589`

Primary source anchors:
- `protocol/src/permissions.rs`
- `protocol/src/request_permissions.rs`
- `core/src/session/mod.rs`
- `app-server/src/bespoke_event_handling.rs`
- `app-server-protocol/src/protocol/v2.rs`
- `core/src/mcp_tool_approval_templates.rs`
- `core/src/consequential_tool_message_templates.json`

This directory owns the TypeScript port of the structured request-permissions
RPC substrate and MCP approval template renderer:
- `request-permissions.ts` defines structured permission request, response,
  event, normalization, conservative grant intersection, and a narrow in-memory
  pending request helper.
- `mcp-tool-approval-templates.ts` defines the template schema loader and pure
  renderer for MCP tool-call approval prompts.

Deferred integration:
- The daemon protocol still exposes the existing string-label permission
  request notification and tool decision methods. Wiring structured permission
  grants through daemon clients is a later integration item.
- The donor app-connector template catalogue is not copied because AgenC does
  not own a matching connector namespace in this item. Callers inject
  AgenC-owned template files when a connector surface exists.
