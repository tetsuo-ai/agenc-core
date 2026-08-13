import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  discoverNeovim,
  type NeovimDiscoveryResult,
} from "../../../src/tui/workbench/buffer/neovim/NeovimDiscovery.js";
import type { NeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import {
  startEmbeddedNeovim as startEmbeddedNeovimProcess,
  type EmbeddedNeovimSession,
  type EmbeddedNeovimStartupContext,
  type EmbeddedNeovimStartupPreparation,
  type StartEmbeddedNeovimOptions,
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
import type { BufferWorkspaceWriteRequest } from "../../../src/tui/workbench/buffer/providers/types.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import {
  WorkspaceEditorLeaseSynchronizer,
  type WorkspaceEditorLeaseClient,
} from "../../../src/tui/workbench/workspaceEditorLeaseSync.js";
import type { WorkspaceEditorSyncParams } from "../../../src/app-server/protocol/index.js";

type UsableNeovim = Extract<NeovimDiscoveryResult, { readonly usable: true }>;

let dir: string;
let neovim: UsableNeovim;

/**
 * Ceiling on embedded-Neovim startup.
 *
 * This bound exists to catch a hung Neovim, not to assert how fast a machine
 * boots one. A hosted macOS ARM runner has been observed exceeding 20s just to
 * attach the embedded UI, and it took down a DIFFERENT test on each attempt --
 * one that had passed in 718ms on the run before. A fixed bound turns runner
 * variance into red PRs on healthy changes, which trains reviewers to ignore
 * the only gate this repository has. Kept as a pinned literal rather than made
 * configurable: reproducible-build.test.ts asserts this exact line so the
 * hosted lanes cannot drift, and an env override would reintroduce precisely
 * the drift that contract exists to prevent.
 */
const REAL_NEOVIM_STARTUP_TIMEOUT_MS = 60_000;

/**
 * Retried once, because raising the bound did not fix this and could not.
 *
 * Across five hosted runs of this suite the failure landed on a different test
 * every time -- whichever one happened to be starting when the runner stalled
 * -- at 21s, 21s, 30s and then 61s as the bound was raised. A machine that
 * needs over a minute to attach an embedded UI is not slow, it is wedged, and
 * a stall that moves between tests is not a property of any of them. Raising
 * the number again would only move the failure.
 *
 * One retry converts a probabilistic stall into a recoverable event while
 * still failing outright if Neovim is genuinely broken: a real hang fails
 * twice, costing one extra bound, and the second error is what surfaces.
 */
async function startEmbeddedNeovim(
  options: StartEmbeddedNeovimOptions,
): Promise<EmbeddedNeovimSession> {
  const start = (): Promise<EmbeddedNeovimSession> =>
    startEmbeddedNeovimProcess({
      ...options,
      startupTimeoutMs:
        options.startupTimeoutMs ?? REAL_NEOVIM_STARTUP_TIMEOUT_MS,
    });
  try {
    return await start();
  } catch (error) {
    if (!/startup timed out/iu.test(String(error))) throw error;
    return await start();
  }
}

beforeAll(async () => {
  const discovery = await discoverNeovim({
    executable: "nvim",
    useUserInit: false,
  });
  if (!discovery.usable) {
    throw new Error(
      `the pinned real-Neovim capability is required: ${discovery.reason}`,
    );
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
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
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
          canonicalNeovimPath(pathValue),
        ),
      );
      const affected = before.buffers.filter((buffer) =>
        sourcePaths.has(canonicalNeovimPath(buffer.name)),
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
          relative(canonicalSourceDirectory, canonicalNeovimPath(buffer.name)),
        ),
      }));
      await session.rebaseFileBuffers(changes);

      const renamed = await session.inspectBuffers();
      for (const change of changes) {
        expect(
          renamed.buffers.find((buffer) => buffer.handle === change.handle),
        ).toMatchObject({ name: change.toPath, loaded: true });
      }

      await session.deleteFileBuffers(
        changes.map((change) => ({
          handle: change.handle,
          path: change.toPath,
        })),
      );
      const deleted = await session.inspectBuffers();
      expect(
        deleted.buffers.some((buffer) =>
          changes.some((change) => change.handle === buffer.handle),
        ),
      ).toBe(false);
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

  it("blocks user-init writes before RPC authority while preserving user init", async () => {
    const filePath = join(dir, "startup-target.txt");
    const initPath = join(dir, "init.lua");
    const forbiddenPath = join(dir, "written-from-init.txt");
    await Promise.all([
      writeFile(filePath, "disk\n", "utf8"),
      writeFile(
        initPath,
        [
          "vim.g.agenc_real_init_loaded = true",
          "vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'init attempted write' })",
          `pcall(vim.cmd, 'write! ' .. vim.fn.fnameescape(${JSON.stringify(forbiddenPath)}))`,
          "vim.bo.modified = false",
        ].join("\n"),
        "utf8",
      ),
    ]);
    let initObserved = false;
    const requests: BufferWorkspaceWriteRequest[] = [];
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: ["--embed", "-u", initPath],
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      requireWorkspaceWriteAuthority: true,
      beforeOpenFile: async (context) => {
        initObserved =
          (await context.execLua(
            "return vim.g.agenc_real_init_loaded == true",
          )) === true;
      },
      size: { rows: 4, columns: 32 },
      onSnapshot: () => {},
      onBeforeWorkspaceWrite: async (request) => {
        requests.push(request);
        return { allowed: true };
      },
      onError: () => {},
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      expect(initObserved).toBe(true);
      expect(requests).toEqual([]);
      await expect(readFile(forbiddenPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(filePath, "utf8")).toBe("disk\n");
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }
  });

  it("synchronously gates full, range, append, and saveas native writes", async () => {
    const filePath = join(dir, "native-write.txt");
    const rangePath = join(dir, "range-write.txt");
    const appendPath = join(dir, "append-write.txt");
    const saveAsPath = join(dir, "saveas-write.txt");
    await Promise.all([
      writeFile(filePath, "alpha\nbeta\n", "utf8"),
      writeFile(appendPath, "existing\n", "utf8"),
    ]);
    const canonicalFilePath = canonicalNeovimPath(filePath);
    const canonicalSaveAsPath = canonicalNeovimPath(saveAsPath);
    const requests: BufferWorkspaceWriteRequest[] = [];
    let allow = false;
    let command: EmbeddedNeovimStartupContext["command"] | null = null;
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      requireWorkspaceWriteAuthority: true,
      beforeOpenFile: (context) => {
        command = context.command;
        return Promise.resolve();
      },
      size: { rows: 6, columns: 48 },
      onSnapshot: () => {},
      onBeforeWorkspaceWrite: async (request) => {
        requests.push(request);
        return allow
          ? { allowed: true }
          : {
              allowed: false,
              reason: "an Agent workspace mutation is committing",
            };
      },
      onError: () => {},
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      const nvimCommand = command;
      if (nvimCommand === null) {
        throw new Error("embedded Neovim command hook was not captured");
      }
      await session.input("gg0iuser edit <Esc>");
      await waitForAsync(() => session.isDirty());
      await expect(nvimCommand("write")).rejects.toThrow(
        "an Agent workspace mutation is committing",
      );
      expect(requests[0]).toMatchObject({
        target: {
          path: filePath,
          sourcePath: canonicalFilePath,
          kind: "buffer",
          lineStart: 1,
          lineEnd: 2,
        },
        buffers: [
          expect.objectContaining({
            path: canonicalFilePath,
            dirty: true,
            content: "user edit alpha\nbeta\n",
          }),
        ],
      });
      expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\n");

      await expect(nvimCommand(`1write ${rangePath}`)).rejects.toThrow(
        "an Agent workspace mutation is committing",
      );
      expect(requests[1]).toMatchObject({
        target: {
          path: rangePath,
          sourcePath: canonicalFilePath,
          kind: "file",
          lineStart: 1,
          lineEnd: 1,
        },
      });
      await expect(readFile(rangePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(nvimCommand(`2write >> ${appendPath}`)).rejects.toThrow(
        "an Agent workspace mutation is committing",
      );
      expect(requests[2]).toMatchObject({
        target: {
          path: appendPath,
          sourcePath: canonicalFilePath,
          kind: "append",
          lineStart: 2,
          lineEnd: 2,
        },
      });
      expect(await readFile(appendPath, "utf8")).toBe("existing\n");

      allow = true;
      await nvimCommand("write");
      await waitForAsync(
        async () =>
          (await readFile(filePath, "utf8")) === "user edit alpha\nbeta\n",
      );
      await nvimCommand(`saveas! ${saveAsPath}`);
      await waitForAsync(() =>
        readFile(saveAsPath, "utf8").then(
          (content) => content === "user edit alpha\nbeta\n",
          () => false,
        ),
      );
      expect(requests.at(-1)).toMatchObject({
        target: {
          path: saveAsPath,
          sourcePath: canonicalSaveAsPath,
          kind: "buffer",
        },
      });
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }
  });

  it("keeps a real native write off disk while the daemon reports an executing Agent mutation", async () => {
    const filePath = join(dir, "provider-native-race.txt");
    const canonicalFilePath = canonicalNeovimPath(filePath);
    const diskContent = "export const value = 1;\n";
    const editedContent = "export const value = 2;\n";
    await writeFile(filePath, diskContent, "utf8");
    let session: EmbeddedNeovimSession | null = null;
    let executingAgentMutation = false;
    let leaseSequence = -1;
    const syncs: WorkspaceEditorSyncParams[] = [];
    const lease = () => ({
      workspaceRoot: dir,
      editorInstanceId: "real-native-write-editor",
      leaseToken: "real-native-write-lease",
      epoch: 1,
      sequence: leaseSequence,
      expiresAt: Date.now() + 10_000,
    });
    const client = {
      acquireWorkspaceEditor: async () => lease(),
      syncWorkspaceEditor: async (params: WorkspaceEditorSyncParams) => {
        syncs.push(params);
        if (
          executingAgentMutation &&
          params.buffers.some((buffer) => buffer.path === canonicalFilePath)
        ) {
          throw new Error(
            `Cannot synchronize ${filePath} while an admitted workspace write is committing`,
          );
        }
        leaseSequence = params.sequence;
        return {
          accepted: true as const,
          sequence: params.sequence,
          expiresAt: Date.now() + 10_000,
          dirtyPaths: params.buffers
            .filter((buffer) => buffer.dirty)
            .map((buffer) => buffer.path),
          stalePaths: [],
        };
      },
      heartbeatWorkspaceEditor: async () => lease(),
      releaseWorkspaceEditor: async () => ({
        released: true as const,
        stalePaths: [],
      }),
    } satisfies WorkspaceEditorLeaseClient;
    const provider = new NeovimBufferProvider({
      discovery: neovim,
      workspaceRoot: dir,
      requireWorkspaceWriteAuthority: true,
      startSession: async (options: StartEmbeddedNeovimOptions) => {
        session = await startEmbeddedNeovim(options);
        return session;
      },
    });
    const synchronizer = new WorkspaceEditorLeaseSynchronizer({
      workspaceRoot: dir,
      editorInstanceId: "real-native-write-editor",
      client,
      buffers: provider,
      syncDebounceMs: 1_000,
      heartbeatMs: 5_000,
      retryMs: 1_000,
    });
    synchronizer.start();

    try {
      await provider.open({ filePath });
      expect(provider.getSnapshot()).toMatchObject({
        absolutePath: canonicalFilePath,
        providerStatus: "ready",
      });
      await waitForAsync(async () => syncs.length >= 1, 15_000);
      const embedded = session;
      if (embedded === null) {
        throw new Error("real Neovim provider did not publish its session");
      }
      await embedded.input("gg0Diexport const value = 2;<Esc>");
      await waitForAsync(() => embedded.isDirty());

      executingAgentMutation = true;
      await expect(embedded.save(false)).rejects.toThrow(
        "while an admitted workspace write is committing",
      );
      expect(await readFile(filePath, "utf8")).toBe(diskContent);
      expect(syncs.at(-1)).toMatchObject({
        buffers: [
          expect.objectContaining({
            path: canonicalFilePath,
            dirty: true,
            content: editedContent,
          }),
        ],
      });

      executingAgentMutation = false;
      await waitForAsync(async () => {
        try {
          return await embedded.save(false);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes(
              "Another authoritative workspace operation is still settling",
            )
          ) {
            return false;
          }
          throw error;
        }
      });
      await waitForAsync(
        async () => (await readFile(filePath, "utf8")) === editedContent,
      );
    } finally {
      executingAgentMutation = false;
      await synchronizer.prepareStop().catch(() => {});
      await provider.cleanup().catch(() => {});
      await synchronizer.stop().catch(() => {});
    }
  });

  it("preserves exact unsaved bytes for recovery on abnormal terminal teardown", async () => {
    const filePath = join(dir, "stdin-loss-recovery.txt");
    const diskContent = "disk content\n";
    const agencHome = join(dir, "agenc-home");
    await writeFile(filePath, diskContent, "utf8");
    let recoveryPaths: NeovimRecoveryPaths | null = null;
    const beforeOpenFile = async (
      context: EmbeddedNeovimStartupContext,
    ): Promise<EmbeddedNeovimStartupPreparation | void> => {
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
    const source = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      agencHome,
      beforeOpenFile,
      startupTimeoutMs: REAL_NEOVIM_STARTUP_TIMEOUT_MS,
      size: { rows: 4, columns: 32 },
      onSnapshot: () => {},
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const sourcePid = source.pid;
    await source.input("gg0iunsaved 🙂 ");
    await expect(source.isDirty()).resolves.toBe(true);
    const sourceManifest = await source.inspectBuffers();
    const sourceHandle = sourceManifest.activeBufferHandle;
    const expected = await source.readBufferText(sourceHandle);

    await source.cleanup({ preserveRecovery: true });
    await waitUntilDead(sourcePid);
    expect(await readFile(filePath, "utf8")).toBe(diskContent);
    const paths = recoveryPaths;
    if (paths === null) {
      throw new Error("private abnormal-exit recovery was not configured");
    }
    const swaps = await listRecoverySwapFiles(paths);
    expect(swaps.length).toBeGreaterThan(0);

    const recoveryEvents: Array<{
      readonly swapFile: string;
      readonly filePath: string;
    }> = [];
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
      startupTimeoutMs: REAL_NEOVIM_STARTUP_TIMEOUT_MS,
      size: { rows: 4, columns: 32 },
      onSnapshot: () => {},
      onRecoveryDetected: (event) => recoveryEvents.push(event),
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    try {
      const recoveryEvent = await waitForValue(
        recoveryEvents,
        (event) => resolve(event.filePath) === resolve(filePath),
      );
      const copyPath = join(paths.copies, "stdin-loss.saved-copy");
      const recoveredHandle = await recovered.applyRecovery(
        "save-copy",
        recoveryEvent.swapFile,
        copyPath,
      );
      await recovered.finishRecovery(recoveredHandle, false);
      expect(await readFile(copyPath, "utf8")).toBe(expected);
      expect(await readFile(filePath, "utf8")).toBe(diskContent);
    } finally {
      await recovered.quit(true);
      await recovered.cleanup();
    }
  });

  it("retains the live process when abnormal recovery cannot preserve every dirty buffer", async () => {
    const filePath = join(dir, "unpreservable-buffer.txt");
    const agencHome = join(dir, "agenc-home");
    const recoveryBlocker = join(dir, "not-a-swap-directory");
    await Promise.all([
      writeFile(filePath, "disk content\n", "utf8"),
      writeFile(recoveryBlocker, "regular file", "utf8"),
    ]);
    let execLua: EmbeddedNeovimStartupContext["execLua"] | null = null;
    const beforeOpenFile = async (
      context: EmbeddedNeovimStartupContext,
    ): Promise<EmbeddedNeovimStartupPreparation | void> => {
      execLua = context.execLua;
      const prepared = await installPrivateNeovimRecovery(context);
      if (!prepared) return;
      return {
        recovery: {
          ...prepared.paths,
          swapFiles: prepared.swapFiles,
        },
      };
    };
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      agencHome,
      beforeOpenFile,
      cleanupTimeoutMs: 50,
      size: { rows: 4, columns: 32 },
      onSnapshot: () => {},
      onError: () => {},
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.input("gg0iunsaved source bytes <Esc>");
      await waitForAsync(() => session.isDirty());
      const startupExecLua = execLua;
      if (!startupExecLua) {
        throw new Error("embedded Neovim execLua hook was not captured");
      }
      // Remove the existing swap and point 'directory' at a regular file.
      // Neovim then rejects :preserve with E313. This is a deterministic real
      // transport failure, not a mock-only malformed response.
      await startupExecLua(
        [
          "vim.bo.swapfile = false",
          `vim.o.directory = ${JSON.stringify(`${recoveryBlocker}//`)}`,
          "return true",
        ].join("\n"),
      );

      await expect(session.cleanup({ preserveRecovery: true })).rejects.toThrow(
        "Embedded Neovim remains live because exact recovery preservation was not confirmed",
      );
      expect(session.recoveryPreservationProven).toBe(false);
      expect(isProcessAlive(pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      session.kill("SIGKILL");
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("keeps a poisoned dirty process live until a retry proves exact recovery", async () => {
    const filePath = join(dir, "poisoned-recovery.txt");
    const diskContent = "disk content\n";
    const agencHome = join(dir, "agenc-home");
    await writeFile(filePath, diskContent, "utf8");
    let recoveryPaths: NeovimRecoveryPaths | null = null;
    let execLua: EmbeddedNeovimStartupContext["execLua"] | null = null;
    const fatalErrors: Error[] = [];
    const beforeOpenFile = async (
      context: EmbeddedNeovimStartupContext,
    ): Promise<EmbeddedNeovimStartupPreparation | void> => {
      execLua = context.execLua;
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
    const source = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      workspaceRoot: dir,
      agencHome,
      beforeOpenFile,
      cleanupTimeoutMs: 250,
      size: { rows: 4, columns: 32 },
      onSnapshot: () => {},
      onError: () => {},
      onFatalError: (error) => fatalErrors.push(error),
      onExit: () => {},
    });
    const sourcePid = source.pid;

    try {
      await source.input("gg0ipoisoned unsaved 🙂 <Esc>");
      await waitForAsync(() => source.isDirty());
      const manifest = await source.inspectBuffers();
      const active = manifest.buffers.find((buffer) => buffer.current);
      if (!active || active.changedtick === null) {
        throw new Error("poisoned recovery test has no stable active buffer");
      }
      const expected = await source.readBufferText(active.handle);
      const startupExecLua = execLua;
      if (!startupExecLua) {
        throw new Error("embedded Neovim execLua hook was not captured");
      }
      await startupExecLua(String.raw`
        _G.AgenCTestOriginalStageEditorProposal =
          _G.AgenCStageEditorProposal
        _G.AgenCStageEditorProposal = function(...)
          vim.uv.sleep(1000)
          return _G.AgenCTestOriginalStageEditorProposal(...)
        end
        return true
      `);
      const proposal = {
        version: 1 as const,
        interaction_id: "poisoned-recovery-proposal",
        path: filePath,
        buffer_handle: active.handle,
        base_changedtick: active.changedtick,
        base_content_sha256: sha256(expected),
        summary: "Exercise poisoned recovery ordering",
        edits: [
          {
            id: "poisoned-recovery-edit",
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 0,
            old_text: "",
            new_text: "-- staged only\n",
          },
        ],
      };

      await expect(source.stageProposal(proposal, 25)).rejects.toThrow(
        "timed out after 25ms",
      );
      const preservationFailure = await waitForValue(fatalErrors, (error) =>
        error.message.includes("exact Neovim recovery preservation failed"),
      );
      expect(source.recoveryPreservationProven).toBe(false);
      expect(isProcessAlive(sourcePid)).toBe(true);
      expect(fatalErrors[0]?.message).toContain("timed out after 25ms");
      expect(preservationFailure.message).toContain(
        "exact Neovim recovery preservation failed",
      );

      // The timed-out mutation eventually leaves Neovim's serial RPC queue.
      // A cleanup retry can then obtain the preservation acknowledgement. Only
      // that proven retry may stop the process.
      await withTestTimeout(
        startupExecLua("return true"),
        5_000,
        "timed out waiting for the poisoned Neovim RPC queue to drain",
      );
      await source.cleanup({ preserveRecovery: true });
      await waitUntilDead(sourcePid);
      expect(source.recoveryPreservationProven).toBe(true);
      expect(isProcessAlive(sourcePid)).toBe(false);
      expect(await readFile(filePath, "utf8")).toBe(diskContent);

      const paths = recoveryPaths;
      if (!paths) {
        throw new Error("private poisoned recovery was not configured");
      }
      const swaps = await listRecoverySwapFiles(paths);
      expect(swaps.length).toBeGreaterThan(0);

      const recoveryEvents: Array<{
        readonly swapFile: string;
        readonly filePath: string;
      }> = [];
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
        size: { rows: 4, columns: 32 },
        onSnapshot: () => {},
        onRecoveryDetected: (event) => recoveryEvents.push(event),
        onError: () => {},
        onExit: () => {},
      });
      const recoveredPid = recovered.pid;
      try {
        const recoveryEvent = await waitForValue(
          recoveryEvents,
          (event) => resolve(event.filePath) === resolve(filePath),
        );
        const copyPath = join(paths.copies, "poisoned-recovery.saved-copy");
        const recoveredHandle = await recovered.applyRecovery(
          "save-copy",
          recoveryEvent.swapFile,
          copyPath,
        );
        await recovered.finishRecovery(recoveredHandle, false);
        expect(await readFile(copyPath, "utf8")).toBe(expected);
      } finally {
        await recovered.quit(true);
        await recovered.cleanup();
        await waitUntilDead(recoveredPid);
      }
    } finally {
      if (isProcessAlive(sourcePid)) {
        source.kill("SIGKILL");
        await waitUntilDead(sourcePid);
      }
    }
  });

  it("publishes and captures a final-line-ending-only byte change", async () => {
    const filePath = join(dir, "final-line-ending.txt");
    await writeFile(filePath, "alpha\n", "utf8");
    let workspaceChanges = 0;
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 4, columns: 24 },
      onSnapshot: () => {},
      onWorkspaceChange: () => {
        workspaceChanges += 1;
      },
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      const beforeManifest = await session.inspectBuffers();
      const before = beforeManifest.buffers.find(
        (buffer) => buffer.handle === beforeManifest.activeBufferHandle,
      );
      expect(before).toMatchObject({
        changedtick: expect.any(Number),
        endOfLine: true,
        modified: false,
      });
      const changesBeforeOption = workspaceChanges;

      await session.input("<Esc>:set noeol<CR>");
      let afterManifest = await session.inspectBuffers();
      let after = afterManifest.buffers.find(
        (buffer) => buffer.handle === afterManifest.activeBufferHandle,
      );
      for (
        let attempt = 0;
        attempt < 40 && after?.endOfLine !== false;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        afterManifest = await session.inspectBuffers();
        after = afterManifest.buffers.find(
          (buffer) => buffer.handle === afterManifest.activeBufferHandle,
        );
      }

      expect(after).toMatchObject({
        changedtick: before?.changedtick,
        endOfLine: false,
        modified: false,
      });
      expect(workspaceChanges).toBeGreaterThan(changesBeforeOption);
      await expect(session.readBufferText(after!.handle)).resolves.toBe(
        "alpha",
      );
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

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
      const visual = await waitForSnapshot(snapshots, (snapshot) =>
        snapshot.mode.startsWith("visual"),
      );
      const highlightsById = new Map(
        visual.highlights.map((highlight) => [
          highlight.id,
          highlight.attributes,
        ]),
      );
      const selectedCells =
        visual.cells[0]?.filter((cell) => {
          const attributes = highlightsById.get(cell.highlightId);
          return (
            attributes?.reverse === true ||
            typeof attributes?.background === "number"
          );
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
      writeFile(
        initPath,
        [
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
        ].join("\n"),
        "utf8",
      ),
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
        policy = (await context.execLua(
          [
            "return {",
            "  swapfile = vim.bo.swapfile,",
            "  undofile = vim.bo.undofile,",
            "  directory = vim.o.directory,",
            "  undodir = vim.o.undodir,",
            "  shadafile = vim.o.shadafile,",
            "  updatecount = vim.o.updatecount,",
            "}",
          ].join("\n"),
        )) as Record<string, unknown>;
        return (
          bufferRecoveryEnabled === null ||
          (policy.swapfile === bufferRecoveryEnabled &&
            policy.undofile === bufferRecoveryEnabled)
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
    await sourceContext.execLua(
      ["vim.bo.undofile = false", "return true"].join("\n"),
    );
    await sourceContext.command("doautocmd BufEnter");
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.openFile(secondFilePath);
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.openFile(filePath);
    await assertPrivateRecoveryPolicy(sourceContext);
    await source.input("gg0irecovered 🙂 ");
    await waitForAsync(() => source.isDirty());
    // Capture the originating process-local revision before :preserve emits
    // its user-visible confirmation. After that command Neovim deliberately
    // waits at a hit-enter prompt, where a synchronous nvim_exec_lua manifest
    // probe cannot run until more terminal input arrives.
    const sourceManifestBeforeCrash = await source.inspectBuffers();
    const sourceBufferBeforeCrash = sourceManifestBeforeCrash.buffers.find(
      (buffer) =>
        canonicalNeovimPath(buffer.name) === canonicalNeovimPath(filePath),
    );
    expect(sourceBufferBeforeCrash?.changedtick).toEqual(expect.any(Number));
    await source.input("<Esc>:preserve | echo 'AGENC_RECOVERY_PRESERVED'<CR>");
    await waitForSnapshot(sourceSnapshots, (snapshot) =>
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
      const cleanReplacementSwap = await recovered.finishRecovery(
        copyHandle,
        false,
      );
      expect(cleanReplacementSwap).not.toBeNull();
      expect(resolve(cleanReplacementSwap!)).not.toBe(
        resolve(recoveryEvent.swapFile),
      );
      expect(await readFile(copyPath, "utf8")).toBe(recoveredContent);
      expect(await readFile(filePath, "utf8")).toBe(diskContent);
      expect(await recovered.readBufferText(copyHandle)).toBe(diskContent);

      const recoveredHandle = await recovered.applyRecovery(
        "compare",
        recoveryEvent.swapFile,
      );
      const replacementSwap = await recovered.finishRecovery(
        recoveredHandle,
        true,
      );
      expect(replacementSwap).not.toBeNull();
      expect(resolve(replacementSwap!)).not.toBe(
        resolve(recoveryEvent.swapFile),
      );

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
      expect(canonicalNeovimPath(recoveredBuffer!.name)).toBe(
        canonicalNeovimPath(filePath),
      );
      // changedtick is an Nvim-process-local counter, not a durable revision
      // identity. The exact recovered bytes below are authoritative even
      // though :recover in this fresh process assigns a different tick.
      expect(recoveredBuffer!.changedtick).not.toBe(
        sourceBufferBeforeCrash!.changedtick,
      );
      expect(diskBuffer!.name).toContain("recovery-compare.txt");
      expect(await recovered.readBufferText(recoveredHandle)).toBe(
        recoveredContent,
      );
      expect(await recovered.readBufferText(diskBuffer!.handle)).toBe(
        diskContent,
      );
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
      await expect(
        session.captureContext({ kind: "selection" }),
      ).resolves.toMatchObject({
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
      await expect(
        session.captureContext({ kind: "selection" }),
      ).resolves.toMatchObject({
        kind: "selection",
        content: "a界🙂\nb界🙂",
        selectionMode: "block",
      });

      // Anchor on the lower-left and finish on the upper-right. Block
      // selections normalize their line and column axes independently.
      await session.input("G0<C-v>2lk<Esc>");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await expect(
        session.captureContext({ kind: "selection" }),
      ).resolves.toMatchObject({
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
      expect(canonicalNeovimPath(visualPlugIntent!.context.path)).toBe(
        canonicalNeovimPath(filePath),
      );

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
      await session.input("i");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(session.captureCodePredictionContext()).resolves.toBeNull();
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("stages revision-bound predictions and reports partial plus full acceptance", async () => {
    const filePath = join(dir, "prediction.ts");
    await writeFile(filePath, "const answer = ", "utf8");
    const feedback: Array<{
      readonly requestId: string;
      readonly kind: string;
      readonly acceptedCharacters?: number;
      readonly latencyMs?: number;
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
      onCodePredictionFeedback: (event) => feedback.push(event),
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.input("ggA");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const manifest = await session.inspectBuffers();
      expect(
        manifest.buffers.find(
          (buffer) => buffer.handle === manifest.activeBufferHandle,
        ),
      ).toMatchObject({
        endOfLine: false,
      });
      const context = await session.captureCodePredictionContext();
      expect(context).toMatchObject({
        path: canonicalNeovimPath(filePath),
        fileBytes: 15,
        cursor: { line: 0, byteColumn: 15 },
        prefix: "const answer = ",
      });
      expect(context).not.toBeNull();
      if (context === null) return;

      await expect(
        session.stageCodePrediction({
          requestId: "prediction-1",
          generation: 1,
          bufferHandle: context.bufferHandle,
          changedtick: context.changedtick,
          cursor: context.cursor,
          text: "first second",
          latencyMs: 20,
        }),
      ).resolves.toBe(true);

      await session.input("<C-Right>");
      await waitForValue(
        feedback,
        (event) => event.kind === "partially_accepted",
      );
      expect(feedback.at(-1)).toMatchObject({
        requestId: "prediction-1",
        kind: "partially_accepted",
        acceptedCharacters: 5,
        latencyMs: 20,
      });
      expect(await session.readBufferText(context.bufferHandle)).toBe(
        "const answer = first",
      );

      await session.input("<Tab>");
      await waitForValue(feedback, (event) => event.kind === "accepted");
      expect(feedback.at(-1)).toMatchObject({
        requestId: "prediction-1",
        kind: "accepted",
        acceptedCharacters: 7,
        latencyMs: 20,
      });
      expect(await session.readBufferText(context.bufferHandle)).toBe(
        "const answer = first second",
      );
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }
  });

  it("captures bounded UTF-8 prediction windows without copying a large buffer", async () => {
    const filePath = join(dir, "large-unicode.ts");
    const content = "é".repeat(20_000);
    await writeFile(filePath, content, "utf8");
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 8, columns: 40 },
      onSnapshot: () => {},
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      await session.input("G$a");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const atEnd = await session.captureCodePredictionContext();
      expect(atEnd).not.toBeNull();
      expect(atEnd?.fileBytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(Buffer.byteLength(atEnd?.prefix ?? "", "utf8")).toBe(20 * 1024);
      expect(atEnd?.prefix).not.toContain("\uFFFD");
      expect(atEnd?.suffix).toBe("");

      await session.input("<Esc>gg0i");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const atStart = await session.captureCodePredictionContext();
      expect(atStart).not.toBeNull();
      expect(atStart?.prefix).toBe("");
      expect(Buffer.byteLength(atStart?.suffix ?? "", "utf8")).toBe(8 * 1024);
      expect(atStart?.suffix).not.toContain("\uFFFD");
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }

    expect(isProcessAlive(pid)).toBe(false);
  });

  it("keeps editor proposals shadow-only until an exact, one-undo-step acceptance", async () => {
    const filePath = join(dir, "proposal.ts");
    const original = "const first = 1;\nconst second = 2;\n";
    await writeFile(filePath, original, "utf8");
    const session = await startEmbeddedNeovim({
      executable: neovim.executable,
      args: neovim.args,
      filePath,
      line: 1,
      column: 0,
      cwd: dir,
      size: { rows: 8, columns: 48 },
      onSnapshot: () => {},
      onError: (error) => {
        throw error;
      },
      onExit: () => {},
    });
    const pid = session.pid;

    try {
      const manifest = await session.inspectBuffers();
      const active = manifest.buffers.find((buffer) => buffer.current);
      expect(active?.changedtick).not.toBeNull();
      if (!active || active.changedtick === null) return;
      const proposal = {
        version: 1 as const,
        interaction_id: "proposal-interaction",
        path: filePath,
        buffer_handle: active.handle,
        base_changedtick: active.changedtick,
        base_content_sha256: sha256(original),
        summary: "Update both constants",
        edits: [
          {
            id: "first",
            start_line: 1,
            start_column: 14,
            end_line: 1,
            end_column: 15,
            old_text: "1",
            new_text: "10",
          },
          {
            id: "second",
            start_line: 2,
            start_column: 15,
            end_line: 2,
            end_column: 16,
            old_text: "2",
            new_text: "20",
          },
        ],
      };
      const proposalId = `${proposal.interaction_id}:${proposal.base_changedtick}`;

      await expect(session.stageProposal(proposal)).resolves.toMatchObject({
        ok: true,
        action: "staged",
        proposalId,
      });
      expect(await session.readBufferText(active.handle)).toBe(original);
      const secondProposal = {
        ...proposal,
        interaction_id: "second-proposal-interaction",
      };
      await expect(
        session.stageProposal(secondProposal),
      ).resolves.toMatchObject({
        ok: false,
        reason: "another editor proposal is already awaiting review",
      });
      expect(await session.readBufferText(active.handle)).toBe(original);
      await expect(session.rejectProposal(proposalId)).resolves.toMatchObject({
        ok: true,
        action: "rejected",
      });
      expect(await session.readBufferText(active.handle)).toBe(original);

      await expect(session.stageProposal(proposal)).resolves.toMatchObject({
        ok: true,
        action: "staged",
      });
      await expect(session.acceptProposal(proposalId)).resolves.toMatchObject({
        ok: true,
        action: "accepted",
      });
      expect(await session.readBufferText(active.handle)).toBe(
        "const first = 10;\nconst second = 20;\n",
      );

      await session.input("<Esc>:undo<CR>");
      await waitForBufferText(session, active.handle, original);

      const current = (await session.inspectBuffers()).buffers.find(
        (buffer) => buffer.handle === active.handle,
      );
      expect(current?.changedtick).not.toBeNull();
      if (!current || current.changedtick === null) return;
      const staleProposal = {
        ...proposal,
        interaction_id: "stale-interaction",
        base_changedtick: current.changedtick,
        base_content_sha256: sha256(original),
      };
      const staleId = `${staleProposal.interaction_id}:${staleProposal.base_changedtick}`;
      await expect(session.stageProposal(staleProposal)).resolves.toMatchObject(
        {
          ok: true,
        },
      );
      await session.input("ggA!<Esc>");
      await expect(session.acceptProposal(staleId)).resolves.toMatchObject({
        ok: false,
        stale: true,
        reason: "buffer changed after the proposal was created",
      });
      expect(await session.readBufferText(active.handle)).toBe(
        "const first = 1;!\nconst second = 2;\n",
      );
    } finally {
      await session.quit(true);
      await session.cleanup();
      await waitUntilDead(pid);
    }
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
    if (!execLua)
      throw new Error("embedded Neovim execLua hook was not captured");

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

      const error = await waitForValue(errors, (candidate) =>
        candidate.message.includes("exact-capture limit"),
      );
      expect(error.message).toBe(
        "Editor context exceeds the exact-capture limit (64 KiB or 2,000 lines). Select a smaller range.",
      );
      expect(intents).toEqual([]);
      await expect(
        execLua("return _G.AgenCTestIntegrationNotification"),
      ).resolves.toEqual({
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
  throw new Error(
    `timed out waiting for embedded Neovim snapshot; last=${JSON.stringify(last)}`,
  );
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
  throw new Error(
    `timed out waiting for value; last=${JSON.stringify(values.at(-1))}`,
  );
}

async function waitForBufferText(
  session: Awaited<ReturnType<typeof startEmbeddedNeovim>>,
  handle: number,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if ((await session.readBufferText(handle)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await session.readBufferText(handle)).toBe(expected);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for real embedded Neovim state");
}

async function withTestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
