import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  discoverNeovim,
  type NeovimDiscoveryResult,
} from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import type { NeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import {
  startEmbeddedNeovim,
  type EmbeddedNeovimStartupContext,
  type EmbeddedNeovimStartupPreparation,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import {
  cleanupTrackedNeovimProcesses,
  getTrackedNeovimProcessCountForTesting,
} from "../../../src/tui/workbench/buffer/neovim/NeovimProcess.js";
import { canonicalNeovimPath } from "../../../src/tui/workbench/buffer/neovim/NeovimPath.js";
import {
  discardRecoverySwapFiles,
  installPrivateNeovimRecovery,
  listRecoverySwapFiles,
  type NeovimRecoveryPaths,
} from "../../../src/tui/workbench/buffer/neovim/NeovimRecovery.js";

type UsableNeovim = Extract<NeovimDiscoveryResult, { readonly usable: true }>;

let dir: string;
let neovim: UsableNeovim;

beforeAll(async () => {
  const discovery = await discoverNeovim({
    executable: "nvim",
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
    args: ["--embed", "--clean"],
    useUserInit: false,
  });
  neovim = discovery;
}, 45_000);

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
  it("rebases and unloads active plus hidden directory buffers by stable handle", async () => {
    const sourceDirectory = join(dir, "src");
    const destinationDirectory = join(dir, "lib");
    const activePath = join(sourceDirectory, "active.ts");
    const hiddenPath = join(sourceDirectory, "hidden.ts");
    await mkdir(sourceDirectory);
    await Promise.all([
      writeFile(activePath, "export const active = true;\n", "utf8"),
      writeFile(hiddenPath, "export const hidden = true;\n", "utf8"),
    ]);
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath: activePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 6, columns: 40 },
      onSnapshot: () => {},
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.openFile(hiddenPath);
      const before = await session.inspectBuffers();
      const canonicalSourceDirectory = canonicalNeovimPath(sourceDirectory);
      const sourcePaths = new Set(
        [activePath, hiddenPath].map((pathValue) =>
          canonicalNeovimPath(pathValue)
        ),
      );
      const affected = before.buffers.filter((buffer) =>
        sourcePaths.has(canonicalNeovimPath(buffer.name))
      );
      expect(affected).toHaveLength(2);
      expect(affected.some((buffer) => buffer.current)).toBe(true);
      expect(affected.some((buffer) => !buffer.current)).toBe(true);

      await rename(sourceDirectory, destinationDirectory);
      const canonicalDestinationDirectory =
        canonicalNeovimPath(destinationDirectory);
      const changes = affected.map((buffer) => ({
        handle: buffer.handle,
        fromPath: buffer.name,
        toPath: resolve(
          canonicalDestinationDirectory,
          relative(
            canonicalSourceDirectory,
            canonicalNeovimPath(buffer.name),
          ),
        ),
      }));
      await session.rebaseFileBuffers(changes);

      const renamed = await session.inspectBuffers();
      for (const change of changes) {
        expect(renamed.buffers.find((buffer) => buffer.handle === change.handle))
          .toMatchObject({ name: change.toPath, loaded: true });
      }

      await session.deleteFileBuffers(changes.map((change) => ({
        handle: change.handle,
        path: change.toPath,
      })));
      const deleted = await session.inspectBuffers();
      expect(deleted.buffers.some((buffer) =>
        changes.some((change) => change.handle === buffer.handle)
      )).toBe(false);
      await rm(destinationDirectory, { recursive: true });
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });

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

  it("reasserts private recovery after user buffer hooks, then recovers an exact copy and Compare view", async () => {
    const filePath = join(dir, "recovery-compare.txt");
    const secondFilePath = join(dir, "recovery-second.txt");
    const initPath = join(dir, "recovery-init.lua");
    const diskContent = "disk alpha\nsecond disk line\n";
    const recoveredContent = "recovered 🙂 disk alpha\nsecond disk line\n";
    const agencHome = join(dir, "agenc-home");
    await Promise.all([
      writeFile(filePath, diskContent, "utf8"),
      writeFile(secondFilePath, "second file\n", "utf8"),
      writeFile(initPath, [
        "vim.opt.directory = vim.fn.stdpath('data') .. '/user-swap'",
        "vim.opt.undodir = vim.fn.stdpath('data') .. '/user-undo'",
        "vim.opt.shadafile = 'NONE'",
        "vim.opt.updatecount = 0",
        "vim.opt.swapfile = false",
        "local function disable_recovery(args)",
        "  vim.api.nvim_set_option_value('undofile', false, { buf = args.buf })",
        "end",
        "vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufEnter' }, {",
        "  callback = disable_recovery,",
        "})",
      ].join("\n"), "utf8"),
    ]);

    let recoveryPaths: NeovimRecoveryPaths | null = null;
    const startupContexts: EmbeddedNeovimStartupContext[] = [];
    const beforeOpenFile = async (
      context: EmbeddedNeovimStartupContext,
    ): Promise<EmbeddedNeovimStartupPreparation | void> => {
      startupContexts.push(context);
      const prepared = await installPrivateNeovimRecovery(context);
      if (!prepared) return;
      recoveryPaths = prepared.paths;
      return {
        recovery: {
          ...prepared.paths,
          swapFiles: prepared.swapFiles,
        },
      };
    };

    const sourceErrors: Error[] = [];
    const sourceSnapshots: NeovimRenderSnapshot[] = [];
    const source = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: ["--embed", "-u", initPath],
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      agencHome,
      beforeOpenFile,
      linuxContainment: "subreaper",
      size: { rows: 8, columns: 48 },
      onSnapshot: (snapshot) => sourceSnapshots.push(snapshot),
      onError: (error) => sourceErrors.push(error),
      onExit: () => {},
    });
    const sourcePid = source.pid;
    const sourceContext = startupContexts.at(-1);
    const paths = recoveryPaths;
    if (!sourceContext || !paths) {
      throw new Error("private recovery startup context was not prepared");
    }

    const assertPrivateRecoveryPolicy = async (
      context: EmbeddedNeovimStartupContext,
      bufferRecoveryEnabled: boolean | null = true,
    ): Promise<void> => {
      let policy: Record<string, unknown> = {};
      await waitForAsync(async () => {
        policy = await context.execLua([
          "return {",
          "  swapfile = vim.bo.swapfile,",
          "  undofile = vim.bo.undofile,",
          "  directory = vim.o.directory,",
          "  undodir = vim.o.undodir,",
          "  shadafile = vim.o.shadafile,",
          "  updatecount = vim.o.updatecount,",
          "}",
        ].join("\n")) as Record<string, unknown>;
        return bufferRecoveryEnabled === null ||
          (
            policy.swapfile === bufferRecoveryEnabled &&
            policy.undofile === bufferRecoveryEnabled
          );
      });
      expect(policy).toMatchObject({
        shadafile: paths.shada,
      });
      expect(policy.updatecount).toEqual(expect.any(Number));
      expect(policy.updatecount as number).toBeGreaterThanOrEqual(50);
      if (bufferRecoveryEnabled !== null) {
        expect(policy).toMatchObject({
          swapfile: bufferRecoveryEnabled,
          undofile: bufferRecoveryEnabled,
        });
      }
      expect(policy).toMatchObject({
        directory: expect.stringContaining(paths.swap),
        undodir: expect.stringContaining(paths.undo),
      });
    };

    await assertPrivateRecoveryPolicy(sourceContext);
    await sourceContext.execLua([
      "vim.bo.undofile = false",
      "return true",
    ].join("\n"));
    await sourceContext.command("doautocmd BufEnter");
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.openFile(secondFilePath);
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.openFile(filePath);
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.input("gg0irecovered 🙂 ");
    await waitForAsync(() => source.isDirty());
    await source.input("<Esc>:preserve | echo 'AGENC_RECOVERY_PRESERVED'<CR>");
    await waitForSnapshot(
      sourceSnapshots,
      (snapshot) =>
        snapshot.lines.some((line) => line.includes("AGENC_RECOVERY_PRESERVED")),
    );
    const oldSwap = await waitForRecoverySwap(paths);

    source.kill("SIGKILL");
    await waitUntilDead(sourcePid);
    await source.cleanup();
    expect(isProcessAlive(sourcePid)).toBe(false);
    expect(sourceErrors).toEqual([]);

    const recoveryEvents: Array<{
      readonly swapFile: string;
      readonly filePath: string;
    }> = [];
    const recoveryErrors: Error[] = [];
    const recovered = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      agencHome,
      beforeOpenFile,
      linuxContainment: "subreaper",
      size: { rows: 8, columns: 48 },
      onSnapshot: () => {},
      onRecoveryDetected: (event) => recoveryEvents.push(event),
      onError: (error) => recoveryErrors.push(error),
      onExit: () => {},
    });
    const recoveredPid = recovered.pid;
    const recoveredContext = startupContexts.at(-1);
    if (!recoveredContext) {
      throw new Error("recovered private recovery context was not prepared");
    }

    try {
      await assertPrivateRecoveryPolicy(recoveredContext, null);
      const recoveryEvent = await waitForValue(
        recoveryEvents,
        (event) => resolve(event.filePath) === resolve(filePath),
      );
      expect(resolve(recoveryEvent.swapFile)).toBe(resolve(oldSwap));

      const copyPath = join(paths.copies, "recovery-compare.saved-copy");
      const copyHandle = await recovered.applyRecovery(
        "save-copy",
        recoveryEvent.swapFile,
        copyPath,
      );
      const cleanReplacementSwap = await recovered.finishRecovery(copyHandle, false);
      expect(cleanReplacementSwap).not.toBeNull();
      expect(resolve(cleanReplacementSwap!)).not.toBe(resolve(recoveryEvent.swapFile));
      expect(await readFile(copyPath, "utf8")).toBe(recoveredContent);
      expect(await readFile(filePath, "utf8")).toBe(diskContent);
      expect(await recovered.readBufferText(copyHandle)).toBe(diskContent);

      const recoveredHandle = await recovered.applyRecovery(
        "compare",
        recoveryEvent.swapFile,
      );
      const replacementSwap = await recovered.finishRecovery(recoveredHandle, true);
      expect(replacementSwap).not.toBeNull();
      expect(resolve(replacementSwap!)).not.toBe(resolve(recoveryEvent.swapFile));

      const manifest = await recovered.inspectBuffers();
      const recoveredBuffer = manifest.buffers.find(
        (buffer) => buffer.handle === recoveredHandle,
      );
      const diskBuffer = manifest.buffers.find(
        (buffer) => buffer.bufferType === "nofile",
      );
      expect(manifest.activeBufferHandle).toBe(recoveredHandle);
      expect(recoveredBuffer).toMatchObject({
        listed: true,
        modified: true,
        current: true,
        bufferType: "",
        saveable: true,
      });
      expect(diskBuffer).toMatchObject({
        listed: false,
        modified: false,
        current: false,
        bufferType: "nofile",
        readOnly: true,
        saveable: false,
      });
      expect(canonicalNeovimPath(recoveredBuffer!.name))
        .toBe(canonicalNeovimPath(filePath));
      expect(diskBuffer!.name).toContain("recovery-compare.txt");
      expect(await recovered.readBufferText(recoveredHandle)).toBe(recoveredContent);
      expect(await recovered.readBufferText(diskBuffer!.handle)).toBe(diskContent);
      expect(await readFile(filePath, "utf8")).toBe(diskContent);
      expect(recoveryErrors).toEqual([]);
    } finally {
      await discardRecoverySwapFiles(paths, [oldSwap]);
      await recovered.quit(true);
      await recovered.cleanup();
      await waitUntilDead(recoveredPid);
    }

    expect(isProcessAlive(recoveredPid)).toBe(false);
  });

  it("captures exact Unicode selections and emits AgenC command intents", async () => {
    const filePath = join(dir, "unicode.txt");
    await writeFile(filePath, "a界🙂z\nb界🙂y\n", "utf8");
    const intents: Array<{
      readonly kind: string;
      readonly prompt?: string;
      readonly context: {
        readonly bufferHandle: number;
        readonly path: string;
        readonly content?: string;
        readonly selectionMode?: string;
      };
    }> = [];
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 8, columns: 40 },
      onSnapshot: () => {},
      onIntegrationIntent: (intent) => intents.push(intent),
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.input("<Esc>gg0v2l<Esc>");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await expect(session.captureContext({ kind: "selection" })).resolves.toMatchObject({
        kind: "selection",
        content: "a界🙂",
        selectionMode: "character",
        range: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 8 },
        },
      });

      await session.input("gg0<C-v>2lj<Esc>");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await expect(session.captureContext({ kind: "selection" })).resolves.toMatchObject({
        kind: "selection",
        content: "a界🙂\nb界🙂",
        selectionMode: "block",
      });

      // Anchor on the lower-left and finish on the upper-right. Block
      // selections normalize their line and column axes independently.
      await session.input("G0<C-v>2lk<Esc>");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await expect(session.captureContext({ kind: "selection" })).resolves.toMatchObject({
        kind: "selection",
        content: "a界🙂\nb界🙂",
        selectionMode: "block",
        range: {
          start: { line: 1, column: 0 },
          end: { line: 2, column: 8 },
        },
      });

      await session.input(":xmap <F6> <Plug>(AgenCAttach)<CR>");
      await session.input("gg0v2l<F6>");
      const visualPlugIntent = await waitForValue(
        intents,
        (intent) => intent.kind === "attach",
      );
      expect(visualPlugIntent).toMatchObject({
        kind: "attach",
        context: {
          content: "a界🙂",
          selectionMode: "character",
        },
      });
      expect(canonicalNeovimPath(visualPlugIntent!.context.path))
        .toBe(canonicalNeovimPath(filePath));

      await session.input("<Esc>:AgenCAsk explain unicode<CR>");
      await waitForValue(intents, (intent) => intent.kind === "ask");
      expect(intents.at(-1)).toMatchObject({
        kind: "ask",
        prompt: "explain unicode",
        context: {
          content: "a界🙂z\nb界🙂y",
        },
      });

      await session.input(":enew<CR>iunnamed live bytes<Esc>:AgenCAttach<CR>");
      const unnamedIntent = await waitForValue(
        intents,
        (intent) => intent.kind === "attach" && intent.context.path === "",
      );
      expect(unnamedIntent).toMatchObject({
        kind: "attach",
        context: {
          path: "",
          content: "unnamed live bytes",
        },
      });
      expect(unnamedIntent.context.bufferHandle).toBeGreaterThan(0);
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("replaces an oversized single-line integration capture before rpcnotify", async () => {
    const filePath = join(dir, "oversized-context.txt");
    await writeFile(filePath, "x".repeat(64 * 1024 + 1), "utf8");
    const errors: Error[] = [];
    const intents: Array<{ readonly kind: string }> = [];
    const startup: {
      execLua: EmbeddedNeovimStartupContext["execLua"] | null;
    } = { execLua: null };
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      beforeOpenFile: (context) => {
        startup.execLua = context.execLua;
        return Promise.resolve();
      },
      size: { rows: 8, columns: 40 },
      onSnapshot: () => {},
      onIntegrationIntent: (intent) => intents.push(intent),
      onError: (error) => errors.push(error),
      onExit: () => {},
    });
    const pid = session.pid;
    const execLua = startup.execLua;
    if (!execLua) throw new Error("embedded Neovim execLua hook was not captured");

    try {
      await execLua(String.raw`
        _G.AgenCTestOriginalRpcnotify = vim.rpcnotify
        _G.AgenCTestIntegrationNotification = nil
        vim.rpcnotify = function(channel, event, ...)
          if event == 'agenc_buffer_integration' then
            local args = { ... }
            _G.AgenCTestIntegrationNotification = {
              action = args[1],
              prompt = args[2],
              context = args[3],
            }
          end
          return _G.AgenCTestOriginalRpcnotify(channel, event, ...)
        end
        return true
      `);
      await execLua(
        "return _G.AgenCBufferAction('ask', 'oversized context', false, nil, nil)",
      );

      const error = await waitForValue(
        errors,
        (candidate) => candidate.message.includes("exact-capture limit"),
      );
      expect(error.message).toBe(
        "Editor context exceeds the exact-capture limit (64 KiB or 2,000 lines). Select a smaller range.",
      );
      expect(intents).toEqual([]);
      await expect(execLua(
        "return _G.AgenCTestIntegrationNotification",
      )).resolves.toEqual({
        action: "ask",
        prompt: "oversized context",
        context: { truncated: true },
      });
    } finally {
      await execLua(String.raw`
        if _G.AgenCTestOriginalRpcnotify ~= nil then
          vim.rpcnotify = _G.AgenCTestOriginalRpcnotify
        end
        _G.AgenCTestOriginalRpcnotify = nil
        _G.AgenCTestIntegrationNotification = nil
      `).catch(() => null);
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

async function waitForValue<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const match = values.findLast(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for value; last=${JSON.stringify(values.at(-1))}`);
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for real embedded Neovim state");
}

async function waitForRecoverySwap(
  paths: NeovimRecoveryPaths,
): Promise<string> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const swaps = await listRecoverySwapFiles(paths);
    if (swaps.length > 0) return swaps[0]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for a recovery swap under ${paths.swap}`);
}
