import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sourcePath } from "../helpers/source-path.ts";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

const FIXTURE_PATH = sourcePath("mcp-client/test-fixtures/stdio-pid-server.cjs");

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-mcp-"));
}

function makeConfig(pidFile: string): MCPServerConfig {
  return {
    name: "pid-server",
    command: process.execPath,
    args: [FIXTURE_PATH, pidFile],
    transport: "stdio",
    timeout: 10_000,
  };
}

function makeManager(pidFile: string): MCPManager {
  const manager = new MCPManager([makeConfig(pidFile)]);
  manager.setSandboxExecutionBroker(new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd: process.cwd(),
  }));
  return manager;
}

async function readPid(pidFile: string): Promise<number> {
  const raw = await readFile(pidFile, "utf8");
  return Number.parseInt(raw.trim(), 10);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("MCPManager stdio lifecycle", () => {
  it("reaps stdio MCP child processes on stop()", async () => {
    const dir = await makeTempDir();
    tempDirs.add(dir);
    const pidFile = join(dir, "server.pid");

    const manager = makeManager(pidFile);
    await manager.start({ requireOneReady: true });

    const pid = await readPid(pidFile);
    expect(pid).toBeGreaterThan(0);
    expect(isPidAlive(pid)).toBe(true);

    await manager.stop();

    await waitFor(() => !isPidAlive(pid), `stdio MCP child ${pid} to exit`);
  });

  it("reaps the previous stdio MCP child on reconnectServer()", async () => {
    const dir = await makeTempDir();
    tempDirs.add(dir);
    const pidFile = join(dir, "server.pid");

    const manager = makeManager(pidFile);
    await manager.start({ requireOneReady: true });

    const firstPid = await readPid(pidFile);
    expect(isPidAlive(firstPid)).toBe(true);

    const result = await manager.reconnectServer("pid-server");
    expect(result.success).toBe(true);

    await waitFor(async () => {
      const nextPid = await readPid(pidFile);
      return nextPid !== firstPid && isPidAlive(nextPid);
    }, "new stdio MCP child after reconnect");

    const secondPid = await readPid(pidFile);
    expect(secondPid).not.toBe(firstPid);

    await waitFor(
      () => !isPidAlive(firstPid),
      `previous stdio MCP child ${firstPid} to exit after reconnect`,
    );

    await manager.stop();
    await waitFor(() => !isPidAlive(secondPid), `reconnected stdio MCP child ${secondPid} to exit`);
  });
});
