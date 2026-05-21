import React from "react";
import { describe, expect, test } from "vitest";

import type { MCPServerConnection } from "../../../src/services/mcp/types.js";
import { IdeStatusIndicator } from "../../../src/tui/components/IdeStatusIndicator.js";
import { renderToString } from "../../../src/utils/staticRender.js";

function ideClient(type: MCPServerConnection["type"]): MCPServerConnection {
  return {
    name: "ide",
    type,
    config: {
      ideName: "VS Code",
      scope: "local",
      type: "ws-ide",
      url: "ws://localhost:1234",
    },
  } as unknown as MCPServerConnection;
}

async function renderIndicator(
  ideSelection: React.ComponentProps<typeof IdeStatusIndicator>["ideSelection"],
  mcpClients: MCPServerConnection[] = [ideClient("connected")],
): Promise<string> {
  return renderToString(
    <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />,
    80,
  );
}

async function renderTrimmedIndicator(
  ideSelection: React.ComponentProps<typeof IdeStatusIndicator>["ideSelection"],
  mcpClients?: MCPServerConnection[],
): Promise<string> {
  return (await renderIndicator(ideSelection, mcpClients)).trim();
}

describe("IdeStatusIndicator coverage swarm row 186", () => {
  test("suppresses empty selections even when the IDE client is connected", async () => {
    await expect(
      renderTrimmedIndicator({ text: "", lineCount: 3 }),
    ).resolves.toHaveLength(0);

    await expect(
      renderTrimmedIndicator({ text: "selected", lineCount: 0 }),
    ).resolves.toHaveLength(0);

    await expect(
      renderTrimmedIndicator({ filePath: "", lineCount: 0 }),
    ).resolves.toHaveLength(0);
  });

  test("prefers selected text counts over the file path context", async () => {
    await expect(
      renderIndicator({
        filePath: "/workspace/src/fallback.ts",
        lineCount: 2,
        text: "one\ntwo",
      }),
    ).resolves.toContain("2 lines selected");

    await expect(
      renderIndicator({
        filePath: "/workspace/src/fallback.ts",
        lineCount: 2,
        text: "one\ntwo",
      }),
    ).resolves.not.toContain("In fallback.ts");
  });

  test("renders file context for connected clients without selected text", async () => {
    await expect(
      renderIndicator({ filePath: "/workspace/src/current.ts", lineCount: 0 }),
    ).resolves.toContain("In current.ts");
  });

  test("does not render file or selection context for disconnected clients", async () => {
    await expect(
      renderTrimmedIndicator(
        { filePath: "/workspace/src/current.ts", lineCount: 0 },
        [ideClient("failed")],
      ),
    ).resolves.toHaveLength(0);
  });
});
