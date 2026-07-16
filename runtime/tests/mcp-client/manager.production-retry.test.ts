import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { terminationSeam } = vi.hoisted(() => ({
  terminationSeam: {
    failAlways: false,
    failuresRemaining: 0,
    calls: [] as ChildProcess[],
  },
}));

vi.mock("../../src/utils/supervisedProcess.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/utils/supervisedProcess.js")
  >();
  return {
    ...actual,
    terminateProcessTreeAndWait: async (
      ...args: Parameters<typeof actual.terminateProcessTreeAndWait>
    ): Promise<void> => {
      terminationSeam.calls.push(args[0]);
      if (terminationSeam.failAlways || terminationSeam.failuresRemaining > 0) {
        terminationSeam.failuresRemaining = Math.max(
          0,
          terminationSeam.failuresRemaining - 1,
        );
        throw new Error("injected production MCP cleanup failure");
      }
      await actual.terminateProcessTreeAndWait(...args);
    },
  };
});

vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));

import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { createMCPConnection } from "./connection.js";
import { MCPManager } from "./manager.js";
import {
  AgenCStdioClientTransport,
  createStdioMCPEnvironment,
} from "./transports/stdio.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const transports = new Set<AgenCStdioClientTransport>();
const managers = new Set<MCPManager>();

afterEach(async () => {
  terminationSeam.failAlways = false;
  terminationSeam.failuresRemaining = 0;
  await Promise.all(
    Array.from(managers, async (manager) => {
      managers.delete(manager);
      await manager.stop().catch(() => {});
      manager.setSandboxExecutionBroker(undefined);
    }),
  );
  await Promise.all(
    Array.from(transports, async (transport) => {
      transports.delete(transport);
      await transport.close().catch(() => {});
    }),
  );
  terminationSeam.calls = [];
  vi.resetAllMocks();
});

describe.skipIf(process.platform === "win32")(
  "MCPManager production cleanup retry chain",
  () => {
    it("retains the stdio owner through failure and recovers on a later retry", async () => {
      const { broker, manager, transport, owner } = await startProductionChain(
        "retry-recovery",
      );
      const pid = owner.pid!;
      terminationSeam.failuresRemaining = 1;

      await expect(
        transitionSandboxExecutionBroker(
          broker,
          resolve("mcp-production-retry-new"),
        ),
      ).rejects.toThrow(/old authority restored/);

      expect(ownedChild(transport)).toBe(owner);
      expect(terminationSeam.calls).toEqual([owner]);
      expect(isPidAlive(pid)).toBe(true);
      expect(manager.getConnectionState("retry-recovery")).toMatchObject({
        type: "failed",
        error: expect.stringContaining("cleanup remains unproven"),
      });

      await expect(manager.stop()).resolves.toBeUndefined();
      expect(terminationSeam.calls).toEqual([owner, owner]);
      expect(ownedChild(transport)).toBeUndefined();
      await waitFor(() => !isPidAlive(pid));
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    });

    it("keeps persistent cleanup failure poisoned until the owner is proven closed", async () => {
      const { broker, manager, transport, owner } = await startProductionChain(
        "persistent-failure",
      );
      const pid = owner.pid!;
      terminationSeam.failAlways = true;

      await expect(
        transitionSandboxExecutionBroker(
          broker,
          resolve("mcp-production-persistent-new"),
        ),
      ).rejects.toThrow(/old authority restored/);
      await expect(manager.stop()).resolves.toBeUndefined();

      expect(terminationSeam.calls).toEqual([owner, owner]);
      expect(ownedChild(transport)).toBe(owner);
      expect(isPidAlive(pid)).toBe(true);
      expect(manager.getConnectionState("persistent-failure")).toMatchObject({
        type: "failed",
        error: expect.stringContaining("cleanup remains unproven"),
      });
      await expect(manager.start()).rejects.toThrow(
        /cleanup|connection lifecycle is active/i,
      );
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

      terminationSeam.failAlways = false;
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(terminationSeam.calls).toEqual([owner, owner, owner]);
      expect(ownedChild(transport)).toBeUndefined();
      await waitFor(() => !isPidAlive(pid));
    });
  },
);

async function startProductionChain(serverName: string): Promise<{
  broker: SandboxExecutionBroker;
  manager: MCPManager;
  transport: AgenCStdioClientTransport;
  owner: ChildProcess;
}> {
  const broker = new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd: process.cwd(),
  });
  const transport = new AgenCStdioClientTransport(
    {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: createStdioMCPEnvironment(undefined, undefined),
    },
    undefined,
    broker,
  );
  transports.add(transport);
  await transport.start();
  const owner = ownedChild(transport);
  if (owner === undefined || owner.pid === undefined) {
    throw new Error("expected production MCP stdio owner");
  }
  mockCreateMCPConnection.mockResolvedValueOnce({
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    close: () => transport.close(),
  });
  const manager = new MCPManager([
    { name: serverName, command: process.execPath },
  ]);
  managers.add(manager);
  manager.setSandboxExecutionBroker(broker);
  await manager.start({ requireOneReady: true });
  return { broker, manager, transport, owner };
}

function ownedChild(
  transport: AgenCStdioClientTransport,
): ChildProcess | undefined {
  return (transport as unknown as { child: ChildProcess | undefined }).child;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for MCP stdio owner to exit");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
