import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  spawnNeovimProcess,
  waitForNeovimExit,
} from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";

function processIsRunning(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const processNameEnd = stat.lastIndexOf(")");
      const state = stat.slice(processNameEnd + 2, processNameEnd + 3);
      return state !== "Z" && state !== "X";
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsRunning(pid);
}

describe("embedded Neovim process teardown", () => {
  it.runIf(process.platform === "linux")(
    "kills an immediate setsid descendant after its Neovim leader exits",
    async () => {
      const descendantSource =
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const leaderSource = [
        "const { spawn } = require('node:child_process');",
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(
          descendantSource,
        )}], { detached: true, stdio: 'ignore' });`,
        "process.stdout.write(String(descendant.pid) + '\\n', () => process.exit(0));",
      ].join("");
      const handle = spawnNeovimProcess({
        executable: process.execPath,
        args: ["-e", leaderSource],
        cwd: process.cwd(),
        env: process.env,
      });
      const child = handle.child;
      child.stdin.end();
      const leaderExit = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      const descendantPid = await new Promise<number>((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          const pid = Number(output.slice(0, newline));
          if (Number.isSafeInteger(pid) && pid > 0) resolve(pid);
          else reject(new Error(`Invalid descendant pid: ${output}`));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          reject(new Error(`Leader failed: ${chunk.toString("utf8")}`));
        });
      });

      try {
        await leaderExit;
        expect(child.exitCode).toBe(0);

        await waitForNeovimExit(child, 50);

        expect(await waitUntilStopped(descendantPid, 1_000)).toBe(true);
      } finally {
        if (processIsRunning(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The descendant exited between the liveness check and cleanup.
          }
        }
        handle.kill("SIGKILL");
      }
    },
  );
});
