import { describe, expect, test } from "vitest";
import type { ToolRegistry } from "../../tool-registry.js";
import {
  formatMcpSseServeUrl,
  resolveMcpServeDefaults,
  startMcpServerFromConfig,
} from "./start.js";

const EMPTY_REGISTRY: ToolRegistry = {
  tools: [],
  toLLMTools: () => [],
  async dispatch() {
    return { content: "" };
  },
};

describe("mcp server start config", () => {
  test("resolves disabled stdio defaults and safe malformed fallbacks", () => {
    expect(resolveMcpServeDefaults(undefined)).toEqual({
      enabled: false,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
    expect(
      resolveMcpServeDefaults({
        enabled: true,
        transport: "http" as never,
        host: "   ",
        port: -1,
      }),
    ).toEqual({
      enabled: true,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
  });

  test("keeps valid configured port boundaries", () => {
    expect(resolveMcpServeDefaults({ port: 0 }).port).toBe(0);
    expect(resolveMcpServeDefaults({ port: 65_535 }).port).toBe(65_535);
  });

  test("does not autostart disabled or daemon-unsupported stdio modes", async () => {
    await expect(startMcpServerFromConfig(undefined)).resolves.toMatchObject({
      kind: "disabled",
      defaults: { enabled: false, transport: "stdio" },
    });
    await expect(
      startMcpServerFromConfig({ mcp: { server: { enabled: true } } }),
    ).resolves.toMatchObject({
      kind: "unsupported",
      defaults: { enabled: true, transport: "stdio" },
    });
  });

  test("starts enabled SSE mode on a real loopback HTTP server", async () => {
    const result = await startMcpServerFromConfig(
      {
        mcp: {
          server: {
            enabled: true,
            transport: "sse",
            host: "127.0.0.1",
            port: 0,
          },
        },
      },
      { toolRegistry: EMPTY_REGISTRY },
    );
    if (result.kind !== "started") {
      throw new Error(`expected started result, got ${result.kind}`);
    }
    try {
      expect(result.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const response = await fetch(result.server.url, {
        method: "GET",
        headers: { accept: "text/event-stream" },
      });
      expect(response.status).toBe(400);
    } finally {
      await result.server.close();
    }
  });

  test("rejects non-loopback SSE hosts", () => {
    expect(() => formatMcpSseServeUrl("0.0.0.0", 3334)).toThrow(
      "only binds to loopback hosts",
    );
  });
});
