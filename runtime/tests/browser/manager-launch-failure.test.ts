import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const { terminationSeam } = vi.hoisted(() => ({
  terminationSeam: { failuresRemaining: 0, calls: 0 },
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
      terminationSeam.calls += 1;
      if (terminationSeam.failuresRemaining > 0) {
        terminationSeam.failuresRemaining -= 1;
        throw new Error("injected browser launch cleanup failure");
      }
      await actual.terminateProcessTreeAndWait(...args);
    },
  };
});

import { BrowserManager } from "../../src/browser/manager.js";
import type { BrowserPolicy } from "../../src/browser/config.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

function isLivePid(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const state = stat.slice(closeParen + 2).trim().split(/\s+/)[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("BrowserManager failed launch ownership", () => {
  const testPosix = process.platform === "win32" ? test.skip : test;

  testPosix(
    "retains the real launch child when CDP cleanup fails",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-browser-launch-owner-"));
      const marker = join(dir, "tree.json");
      const descendantScript = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leader: process.ppid,
  descendant: process.pid,
}));
setInterval(() => {}, 1000);
`;
      const leaderScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
});
function exitWhenReady() {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    setTimeout(exitWhenReady, 5);
    return;
  }
  process.exit(29);
}
exitWhenReady();
`;
      const broker = new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: dir,
      });
      const prepareSpawn = vi
        .spyOn(broker, "prepareSpawn")
        .mockImplementation((_surface, command) => ({
          program: process.execPath,
          args: ["-e", leaderScript],
          cwd: dir,
          env: command.env,
        }));
      const policy: BrowserPolicy = {
        headless: true,
        allowPrivateNetwork: false,
        noSandbox: false,
        navigationTimeoutMs: 30_000,
        executablePath: process.execPath,
      };
      const manager = new BrowserManager({
        policy,
        sandboxExecutionBroker: broker,
      });
      let descendant: number | undefined;
      try {
        terminationSeam.failuresRemaining = 1;
        await expect(manager.page()).rejects.toMatchObject({
          name: "BrowserLaunchCleanupError",
          cleanupError: expect.objectContaining({
            message: "injected browser launch cleanup failure",
          }),
        });
        expect(existsSync(marker)).toBe(true);
        descendant = (
          JSON.parse(readFileSync(marker, "utf8")) as { descendant: number }
        ).descendant;
        expect(isLivePid(descendant)).toBe(true);

        await expect(manager.page()).rejects.toThrow(
          "injected browser launch cleanup failure",
        );
        expect(prepareSpawn).toHaveBeenCalledTimes(1);

        await expect(manager.closeAll()).resolves.toBeUndefined();
        await waitFor(() => !isLivePid(descendant!));
        expect(isLivePid(descendant)).toBe(false);
        expect(terminationSeam.calls).toBe(2);
      } finally {
        terminationSeam.failuresRemaining = 0;
        await manager.closeAll().catch(() => {});
        let leader: number | undefined;
        if (existsSync(marker)) {
          const tree = JSON.parse(readFileSync(marker, "utf8")) as {
            leader: number;
            descendant: number;
          };
          leader = tree.leader;
          descendant ??= tree.descendant;
        }
        if (leader !== undefined) {
          try {
            process.kill(-leader, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        if (descendant !== undefined) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        prepareSpawn.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
