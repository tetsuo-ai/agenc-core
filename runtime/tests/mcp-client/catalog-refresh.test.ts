import { describe, expect, test, vi } from "vitest";
import { createPromptBridge } from "./prompts.js";
import { createResourceBridge } from "./resources.js";
import { createToolBridge as createToolBridgeWithEnvironment } from "./tools.js";

describe("MCP catalog refresh primitives", () => {
  test("prompt refresh throws instead of swallowing a list failure", async () => {
    const listPrompts = vi.fn().mockRejectedValue(new Error("prompts/list failed"));
    const bridge = await createPromptBridge(
      { listPrompts, close: async () => {} },
      "catalog",
    );

    await expect(bridge.refreshPrompts()).rejects.toThrow("prompts/list failed");
    await expect(bridge.listPrompts()).resolves.toEqual([]);
  });

  test("resource refresh rejects a repeated cursor instead of publishing []", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({
        resources: [{ uri: "file:///a", name: "a" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "file:///b", name: "b" }],
        nextCursor: "page-2",
      });
    const bridge = await createResourceBridge(
      { listResources, close: async () => {} },
      "catalog",
    );

    await expect(bridge.refreshResources()).rejects.toThrow(
      /repeated a resources\/list cursor/u,
    );
    await expect(bridge.listResources()).resolves.toEqual([]);
  });

  test("tool bridge dispose can leave the live client open for a refresh replacement", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const bridge = await createToolBridgeWithEnvironment(
      {
        listTools: async () => ({ tools: [{ name: "ping" }] }),
        close,
      },
      "catalog",
      undefined,
      { environment: {}, ownClient: false },
    );

    expect(bridge.tools.map((tool) => tool.name)).toEqual(["mcp.catalog.ping"]);
    await expect(bridge.dispose()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });
});
