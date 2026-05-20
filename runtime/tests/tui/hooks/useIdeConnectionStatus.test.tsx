import React from "react";
import { describe, expect, test } from "vitest";

import type { MCPServerConnection } from "../../services/mcp/types.js";
import { renderToString } from "../../utils/staticRender.js";
import Text from "../ink/components/Text.js";
import { useIdeConnectionStatus } from "./useIdeConnectionStatus.js";

function connection(
  overrides: Partial<MCPServerConnection> & Record<string, unknown>,
): MCPServerConnection {
  return overrides as MCPServerConnection;
}

function StatusProbe({
  clients,
}: {
  clients?: MCPServerConnection[];
}) {
  const status = useIdeConnectionStatus(clients);

  return <Text>{JSON.stringify(status)}</Text>;
}

async function renderStatus(clients?: MCPServerConnection[]) {
  return renderToString(<StatusProbe clients={clients} />, 100);
}

describe("useIdeConnectionStatus", () => {
  test("returns null status when no IDE client exists", async () => {
    await expect(renderStatus()).resolves.toContain(
      '{"status":null,"ideName":null}',
    );

    await expect(
      renderStatus([
        connection({
          name: "filesystem",
          type: "connected",
          config: { scope: "local", type: "stdio", command: "server" },
        }),
      ]),
    ).resolves.toContain('{"status":null,"ideName":null}');
  });

  test("reports connected SSE IDE clients with their IDE name", async () => {
    await expect(
      renderStatus([
        connection({
          name: "ide",
          type: "connected",
          config: {
            scope: "local",
            type: "sse-ide",
            url: "http://localhost:1",
            ideName: "VS Code",
          },
        }),
      ]),
    ).resolves.toContain('{"status":"connected","ideName":"VS Code"}');
  });

  test("reports pending WebSocket IDE clients with their IDE name", async () => {
    await expect(
      renderStatus([
        connection({
          name: "ide",
          type: "pending",
          config: {
            scope: "local",
            type: "ws-ide",
            url: "ws://localhost:1",
            ideName: "Cursor",
          },
        }),
      ]),
    ).resolves.toContain('{"status":"pending","ideName":"Cursor"}');
  });

  test("reports disconnected for non-connected and non-pending IDE clients", async () => {
    await expect(
      renderStatus([
        connection({
          name: "ide",
          type: "failed",
          config: {
            scope: "local",
            type: "sse-ide",
            url: "http://localhost:1",
            ideName: "Zed",
          },
        }),
      ]),
    ).resolves.toContain('{"status":"disconnected","ideName":"Zed"}');
  });

  test("omits IDE name for ordinary MCP configs named ide", async () => {
    await expect(
      renderStatus([
        connection({
          name: "ide",
          type: "connected",
          config: { scope: "local", type: "stdio", command: "server" },
        }),
      ]),
    ).resolves.toContain('{"status":"connected","ideName":null}');
  });
});
