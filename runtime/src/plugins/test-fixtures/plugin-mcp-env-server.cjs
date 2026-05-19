#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

async function main() {
  const infoFile = process.argv[2];
  if (!infoFile) {
    throw new Error("Expected info file path as argv[2]");
  }

  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(
    infoFile,
    `${JSON.stringify({
      cwd: process.cwd(),
      env: {
        AGENC_PLUGIN_ROOT: process.env.AGENC_PLUGIN_ROOT,
        AGENC_PLUGIN_DATA: process.env.AGENC_PLUGIN_DATA,
        AGENC_PLUGIN_NAME: process.env.AGENC_PLUGIN_NAME,
        AGENC_PLUGIN_MCP_SERVER: process.env.AGENC_PLUGIN_MCP_SERVER,
        AGENC_PLUGIN_SANDBOX: process.env.AGENC_PLUGIN_SANDBOX,
      },
    })}\n`,
    "utf8",
  );

  const server = new McpServer(
    { name: "plugin-mcp-env-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "ping",
    {
      description: "Test ping tool",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: "pong" }],
    }),
  );

  const transport = new StdioServerTransport();
  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // best effort during process teardown
    }
  };
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
