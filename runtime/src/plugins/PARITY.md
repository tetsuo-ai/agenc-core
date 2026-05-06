# Plugin MCP Sandboxing Parity

Upstream references:
- Local OC donor checkout at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
- Local CX donor checkout at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `src/utils/plugins/mcpPluginIntegration.ts`
- `core-plugins/src/manager.rs`

This directory owns the TypeScript port of plugin MCP registration:
- `sandbox.ts` owns plugin MCP child-process isolation metadata, reserved
  environment variables, remote-transport classification, and cwd containment.
- `registration/mcp-plugin-integration.ts` owns plugin server template
  resolution, server-name scoping, issue reporting, and registration handoff.
- `loader.ts` and `manifest-schema.ts` own plugin manifest server-shape
  normalization before registration.
- `test-fixtures/plugin-mcp-env-server.cjs` is the focused MCP stdio server
  fixture used to verify the live child-process startup boundary.
