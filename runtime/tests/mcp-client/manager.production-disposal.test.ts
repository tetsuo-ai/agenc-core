import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));

import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { createMCPConnection } from "./connection.js";
import { MCPManager } from "./manager.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);

describe("MCPManager production disposal chain", () => {
  it("fails strict quiesce when the real tool bridge cannot close its client", async () => {
    const closeError = new Error("process tree survived forced shutdown");
    const oldClient = {
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      close: vi.fn().mockRejectedValue(closeError),
    };
    mockCreateMCPConnection.mockResolvedValueOnce(oldClient);

    const oldCwd = resolve("mcp-production-old");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const manager = new MCPManager([
      { name: "strict-close", command: process.execPath },
    ]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start({ requireOneReady: true });

    await expect(
      transitionSandboxExecutionBroker(
        broker,
        resolve("mcp-production-new"),
      ),
    ).rejects.toThrow(/old authority restored/);

    expect(oldClient.close).toHaveBeenCalledOnce();
    expect(broker.cwd).toBe(oldCwd);
    expect(manager.isConnected("strict-close")).toBe(false);
    expect(manager.getConnectionState("strict-close")).toEqual({
      type: "failed",
      error: expect.stringContaining("cleanup remains unproven"),
    });
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });
});
