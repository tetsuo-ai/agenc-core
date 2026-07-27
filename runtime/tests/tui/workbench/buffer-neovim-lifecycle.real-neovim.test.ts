import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  discoverNeovim,
  type NeovimDiscoveryResult,
} from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import type { NeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { startEmbeddedNeovim } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import {
  cleanupTrackedNeovimProcesses,
  getTrackedNeovimProcessCountForTesting,
} from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";

type UsableNeovim = Extract<NeovimDiscoveryResult, { readonly usable: true }>;

let dir: string;
let neovim: UsableNeovim;

beforeAll(async () => {
  const discovery = await discoverNeovim({
    executable: "nvim",
    timeoutMs: 1000,
    useUserInit: false,
  });
  if (!discovery.usable) {
    throw new Error(`the pinned real-Neovim capability is required: ${discovery.reason}`);
  }
  expect(discovery).toMatchObject({
    usable: true,
    version: {
      major: 0,
      minor: 12,
      patch: 1,
      raw: "NVIM v0.12.1",
    },
    args: ["--embed", "--clean", "-n"],
    useUserInit: false,
  });
  neovim = discovery;
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-real-nvim-lifecycle-"));
});

afterEach(async () => {
  cleanupTrackedNeovimProcesses("SIGKILL");
  await rm(dir, { recursive: true, force: true });
  expect(getTrackedNeovimProcessCountForTesting()).toBe(0);
});

afterAll(() => {
  cleanupTrackedNeovimProcesses("SIGKILL");
});

describe("real embedded Neovim lifecycle", () => {
  it("closes a clean real Neovim session through the all-buffer safe-close path", async () => {
    const filePath = join(dir, "clean-close.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 4, columns: 24 },
      onSnapshot: () => {},
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    await expect(session.quit(false)).resolves.toEqual({ closed: true });
    await session.cleanup();
    await waitUntilDead(pid);

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("detects a modified hidden buffer before an external-editor handoff", async () => {
    const filePath = join(dir, "hidden-buffer.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 4, columns: 24 },
      onSnapshot: () => {},
      onError: () => {},
      onExit: () => {},
    });
    const pid = session.pid;

    await session.input("<Esc>:set hidden<CR>:enew<CR>ihidden edit");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await session.input(`<Esc>:hide edit ${filePath}<CR>`);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(session.isDirty()).resolves.toBe(false);
    await expect(session.hasUnsavedBuffers()).resolves.toBe(true);
    await session.quit(true);
    await session.cleanup();
    await waitUntilDead(pid);

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("opens Neovim, refuses dirty quit, and force cleans the child", async () => {
    const filePath = join(dir, "target.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    const snapshots: string[][] = [];
    const dirtyChanges: boolean[] = [];

    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 21, columns: 116 },
      onSnapshot: (snapshot) => {
        snapshots.push([...snapshot.lines]);
      },
      onDirtyChange: (dirty) => {
        dirtyChanges.push(dirty);
      },
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    await session.input("ibeta");
    await session.paste(" gamma");
    await session.resize({ rows: 4, columns: 24 });
    await session.focus(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(session.isDirty()).resolves.toBe(true);
    await expect(session.quit(false)).resolves.toMatchObject({ closed: false });

    await expect(session.save(true)).resolves.toBe(true);
    await expect(session.isDirty()).resolves.toBe(false);
    expect(await readFile(filePath, "utf8")).toContain("beta gamma");
    expect(dirtyChanges).toContain(false);
    await session.input("omore");
    await session.quit(true);
    await session.cleanup();

    expect(snapshots.length).toBeGreaterThan(0);
    expect(await readFile(filePath, "utf8")).not.toContain("more");
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("reports visible grid highlight cells for visual selections", async () => {
    const filePath = join(dir, "target.txt");
    await writeFile(filePath, "alpha beta gamma\nsecond line\n", "utf8");
    const snapshots: NeovimRenderSnapshot[] = [];

    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 8, columns: 40 },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.input("gg0");
      await waitForSnapshot(
        snapshots,
        (snapshot) => snapshot.cursor.row === 0 && snapshot.cursor.column === 0,
      );
      await session.input("v$");
      const visual = await waitForSnapshot(
        snapshots,
        (snapshot) => snapshot.mode.startsWith("visual"),
      );
      const highlightsById = new Map(
        visual.highlights.map((highlight) => [highlight.id, highlight.attributes]),
      );
      const selectedCells = visual.cells[0]?.filter((cell) => {
        const attributes = highlightsById.get(cell.highlightId);
        return attributes?.reverse === true || typeof attributes?.background === "number";
      }) ?? [];

      expect(visual.lines[0]).toContain("alpha beta gamma");
      expect(selectedCells.length).toBeGreaterThan(0);
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });
});

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForSnapshot<T>(
  snapshots: readonly T[],
  predicate: (snapshot: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 1500;
  let last = snapshots.at(-1);
  while (Date.now() < deadline) {
    const match = snapshots.findLast(predicate);
    if (match) return match;
    last = snapshots.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for embedded Neovim snapshot; last=${JSON.stringify(last)}`);
}
