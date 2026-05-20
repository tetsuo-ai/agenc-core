import { describe, expect, test, vi } from "vitest";

import {
  createElicitationQueue,
  type McpFormPending,
  type McpUrlPending,
} from "./App.js";

describe("App elicitation queue coverage", () => {
  test("completes queued MCP URL requests without replacing the active prompt", () => {
    const queue = createElicitationQueue();
    const activeResolve = vi.fn();
    const queuedResolve = vi.fn();
    const active: McpFormPending = {
      kind: "mcp-form",
      request: {
        turnId: "turn-1",
        serverName: "forms",
        requestId: "form-1",
        request: {
          mode: "form",
          message: "Provide value",
          requestedSchema: {
            type: "object",
            properties: {},
          },
        },
      },
      resolve: activeResolve,
      fields: [],
      content: {},
      index: 0,
    };
    const queued: McpUrlPending = {
      kind: "mcp-url",
      request: {
        turnId: "turn-1",
        serverName: "auth",
        requestId: "url-1",
        request: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url-1",
          url: "https://example.test/auth",
        },
      },
      resolve: queuedResolve,
    };

    expect(queue.enqueue(active)).toBe(active);
    expect(queue.enqueue(queued)).toBe(active);

    expect(queue.completeMcpUrl("auth", "url-1")).toEqual({
      handled: true,
      current: active,
    });

    expect(queuedResolve).toHaveBeenCalledWith({ action: "accept" });
    expect(activeResolve).not.toHaveBeenCalled();
    expect(queue.current()).toBe(active);
    expect(queue.clear()).toEqual([active]);
  });
});
