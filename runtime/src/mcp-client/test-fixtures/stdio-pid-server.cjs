#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

async function main() {
  const pidFile = process.argv[2];
  if (!pidFile) {
    throw new Error("Expected pid file path as argv[2]");
  }

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");

  const server = new McpServer(
    { name: "stdio-pid-server", version: "1.0.0" },
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
