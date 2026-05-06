import { describe, expect, it, vi } from "vitest";

import { listAgenCDaemonAgents } from "./index.js";

function createListClient(
  pages: Array<{
    readonly agents: readonly {
      readonly agentId: string;
      readonly status: "idle" | "running" | "stopping" | "stopped" | "error";
      readonly createdAt: string;
    }[];
    readonly nextCursor?: string;
  }>,
) {
  let index = 0;
  return {
    request: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]),
    subscribeToSessionEvents: vi.fn(() => () => undefined),
    getConnectionState: vi.fn(() => ({ status: "connected" })),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("app-server-client daemon helpers", () => {
  it("collects daemon agent pages until the cursor ends", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_1",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
          },
        ],
        nextCursor: "page_2",
      },
      {
        agents: [
          {
            agentId: "agent_2",
            status: "idle",
            createdAt: "2026-05-06T00:00:01.000Z",
          },
        ],
      },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).resolves.toEqual([
      expect.objectContaining({ agentId: "agent_1" }),
      expect.objectContaining({ agentId: "agent_2" }),
    ]);
    expect(client.request).toHaveBeenNthCalledWith(1, "agent.list", {
      limit: 100,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "agent.list", {
      limit: 100,
      cursor: "page_2",
    });
  });

  it("rejects repeated cursors instead of looping forever", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "same" },
      { agents: [], nextCursor: "same" },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).rejects.toThrow(
      "repeated agent list cursor",
    );
  });

  it("caps daemon agent pagination", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "page_2" },
      { agents: [], nextCursor: "page_3" },
    ]);

    await expect(
      listAgenCDaemonAgents(client as never, { maxPages: 1 }),
    ).rejects.toThrow("exceeded pagination limit");
  });
});
