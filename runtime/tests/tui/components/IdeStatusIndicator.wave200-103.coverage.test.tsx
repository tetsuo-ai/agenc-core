import React from "react";
import { describe, expect, test } from "vitest";

import type { MCPServerConnection } from "../../services/mcp/types.js";
import { renderToString } from "../../utils/staticRender.js";
import { IdeStatusIndicator } from "./IdeStatusIndicator.js";

function ideClient(type: MCPServerConnection["type"]): MCPServerConnection {
  return {
    name: "ide",
    type,
    config: {
      type: "ws-ide",
      url: "ws://localhost:1234",
      ideName: "VS Code",
      scope: "local",
    },
  } as unknown as MCPServerConnection;
}

describe("IdeStatusIndicator coverage", () => {
  test("renders selection context only when the IDE client is connected", async () => {
    expect(
      (
        await renderToString(
          <IdeStatusIndicator
            ideSelection={{ filePath: "/repo/src/app.tsx", lineCount: 0 }}
            mcpClients={[]}
          />,
          80,
        )
      ).trim(),
    ).toBe("");

    expect(
      (
        await renderToString(
          <IdeStatusIndicator
            ideSelection={{ filePath: "/repo/src/app.tsx", lineCount: 0 }}
            mcpClients={[ideClient("pending")]}
          />,
          80,
        )
      ).trim(),
    ).toBe("");

    expect(
      (
        await renderToString(
          <IdeStatusIndicator
            ideSelection={undefined}
            mcpClients={[ideClient("connected")]}
          />,
          80,
        )
      ).trim(),
    ).toBe("");

    await expect(
      renderToString(
        <IdeStatusIndicator
          ideSelection={{ text: "selected", lineCount: 1 }}
          mcpClients={[ideClient("connected")]}
        />,
        80,
      ),
    ).resolves.toContain("1 line selected");

    await expect(
      renderToString(
        <IdeStatusIndicator
          ideSelection={{ text: "first\nsecond", lineCount: 2 }}
          mcpClients={[ideClient("connected")]}
        />,
        80,
      ),
    ).resolves.toContain("2 lines selected");

    await expect(
      renderToString(
        <IdeStatusIndicator
          ideSelection={{ filePath: "/repo/src/app.tsx", lineCount: 0 }}
          mcpClients={[ideClient("connected")]}
        />,
        80,
      ),
    ).resolves.toContain("In app.tsx");
  });
});
