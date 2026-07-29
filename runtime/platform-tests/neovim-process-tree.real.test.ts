import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discoverNeovim,
  type NeovimDiscoveryResult,
} from "../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import {
  captureNeovimProcessDescendants,
  spawnNeovimProcess,
  waitForNeovimExit,
  type NeovimProcessHandle,
} from "../src/tui/workbench/buffer/neovim/NeovimProcess.js";
import { NeovimRpcTransport } from "../src/tui/workbench/buffer/neovim/NeovimRpc.js";

type UsableNeovim = Extract<NeovimDiscoveryResult, { readonly usable: true }>;

let neovim: UsableNeovim;
const cleanupPids = new Set<number>();

beforeAll(async () => {
  const discovery = await discoverNeovim({
    executable: "nvim",
    useUserInit: false,
  });
  if (!discovery.usable) {
    throw new Error(
      `the pinned hosted-platform Neovim capability is required: ${discovery.reason}`,
    );
  }
  expect(discovery.version.raw).toBe("NVIM v0.12.1");
  neovim = discovery;
}, 45_000);

afterAll(() => {
  for (const pid of cleanupPids) forceCleanupPid(pid);
});

describe("hosted-platform Neovim observed-descendant cleanup", () => {
  it("terminates a TERM-resistant job with the embedded Neovim tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-neovim-platform-tree-"));
    let owned: OwnedNeovimJob | undefined;
    try {
      owned = await startOwnedNeovimJob(dir, "forced");
      expect(processIsRunning(owned.descendantPid)).toBe(true);

      await waitForNeovimExit(owned.handle.child, 1_000);
      owned.rpc.close("platform process-tree test complete");

      expect(await waitUntilStopped(owned.descendantPid, 5_000)).toBe(true);
      expect(processIsRunning(owned.handle.pid)).toBe(false);
      cleanupPids.delete(owned.descendantPid);
      cleanupPids.delete(owned.handle.pid);
    } finally {
      owned?.rpc.close("platform process-tree test cleanup");
      if (owned) {
        forceCleanupTree(owned.handle.pid);
        forceCleanupPid(owned.descendantPid);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it("cleans a detached job when the Neovim leader exits naturally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-neovim-platform-natural-"));
    let owned: OwnedNeovimJob | undefined;
    try {
      owned = await startOwnedNeovimJob(dir, "natural");
      expect(processIsRunning(owned.descendantPid)).toBe(true);

      // :qa! may close the RPC stream before returning a response. The
      // production owner must still retain the kernel/fallback boundary and
      // reap the detached, TERM-resistant job.
      await owned.rpc.request(
        "nvim_command",
        ["qa!"],
        { timeoutMs: 5_000 },
      ).catch(() => null);
      await waitForNeovimExit(owned.handle.child, 1_000);
      owned.rpc.close("platform natural-exit test complete");

      expect(await waitUntilStopped(owned.descendantPid, 5_000)).toBe(true);
      expect(processIsRunning(owned.handle.pid)).toBe(false);
      cleanupPids.delete(owned.descendantPid);
      cleanupPids.delete(owned.handle.pid);
    } finally {
      owned?.rpc.close("platform natural-exit test cleanup");
      if (owned) {
        forceCleanupTree(owned.handle.pid);
        forceCleanupPid(owned.descendantPid);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);
});

type OwnedNeovimJob = {
  readonly handle: NeovimProcessHandle;
  readonly rpc: NeovimRpcTransport;
  readonly descendantPid: number;
};

const DESCENDANT_MARKER = "agenc-neovim-platform-descendant";

async function startOwnedNeovimJob(
  dir: string,
  suffix: string,
): Promise<OwnedNeovimJob> {
  const descendantPidFile = join(dir, `${suffix}-descendant.pid`);
  const handle = spawnNeovimProcess({
    executable: neovim.executable,
    args: neovim.args,
    cwd: dir,
  });
  cleanupPids.add(handle.pid);
  const rpc = new NeovimRpcTransport(handle.child.stdout, handle.child.stdin);
  rpc.start();
  try {
    const descendantSource = [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.argv[1], String(process.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const job = await rpc.request(
      "nvim_call_function",
      [
        "jobstart",
        [
          [
            process.execPath,
            "-e",
            descendantSource,
            descendantPidFile,
            DESCENDANT_MARKER,
          ],
          // The child deliberately owns a separate session/process group.
          // Only the production cgroup, Job Object, or retained observed
          // Darwin descendant identity can clean it with the editor.
          { detach: true },
        ],
      ],
      { timeoutMs: 5_000 },
    );
    expect(typeof job).toBe("number");
    expect(Number(job)).toBeGreaterThan(0);
    const descendantPid = await readPidFile(descendantPidFile);
    cleanupPids.add(descendantPid);
    captureNeovimProcessDescendants(handle.child);
    return { handle, rpc, descendantPid };
  } catch (error) {
    rpc.close("platform process-tree startup failed");
    forceCleanupTree(handle.pid);
    throw error;
  }
}

async function readPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pid = Number.parseInt(
      await readFile(path, "utf8").catch(() => ""),
      10,
    );
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Neovim job did not write its descendant pid file: ${path}`);
}

function processIsRunning(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsRunning(pid);
}

function forceCleanupTree(pid: number): void {
  if (!processIsRunning(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    forceCleanupPid(pid);
  }
}

function forceCleanupPid(pid: number): void {
  if (!processIsRunning(pid)) {
    cleanupPids.delete(pid);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and cleanup.
  }
  cleanupPids.delete(pid);
}
