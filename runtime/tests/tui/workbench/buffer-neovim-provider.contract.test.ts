import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { canonicalNeovimPath } from "../../../src/tui/workbench/buffer/neovim/NeovimPath.js";
import { bufferIntegrationIntentCommand } from "../../../src/tui/workbench/commands.js";
import { BufferProviderController } from "../../../src/tui/workbench/buffer/providers/BufferProviderController.js";
import {
  neovimFileSnapshotKey,
  NeovimBufferProvider,
  normalizeNeovimBufferPath,
  refreshableFileSnapshotPaths,
  reloadPathAfterExternalEditor,
} from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import type { BufferFileSnapshot } from "../../../src/tui/workbench/buffer/fileSnapshot.js";
import type {
  BufferCodePredictionFeedback,
  BufferIntegrationIntent,
  BufferWorkspaceWriteDecision,
  BufferWorkspaceWriteRequest,
} from "../../../src/tui/workbench/buffer/providers/types.js";
import {
  NeovimStartupCleanupError,
  type EmbeddedNeovimSession,
  type EmbeddedNeovimRecoveryInfo,
  type NeovimExitInfo,
  type StartEmbeddedNeovimOptions,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
  args: ["--embed", "--clean"],
  useUserInit: false,
} as const;

const TEST_WORKSPACE_ROOT =
  process.platform === "win32" ? "C:\\workspace" : "/workspace";
const TEST_OUTSIDE_ROOT =
  process.platform === "win32" ? "C:\\outside" : "/outside";

function workspacePath(...segments: readonly string[]): string {
  return join(TEST_WORKSPACE_ROOT, ...segments);
}

function outsidePath(...segments: readonly string[]): string {
  return join(TEST_OUTSIDE_ROOT, ...segments);
}

function normalizedTestPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

describe("embedded Neovim BUFFER provider", () => {
  it("opens through the injected embedded session and publishes bounded terminal snapshots", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    await provider.open({ filePath: "target.txt", line: 3, column: 2 });

    expect(harness.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/usr/bin/nvim",
        args: ["--embed", "--clean"],
        filePath: workspacePath("target.txt"),
        line: 3,
        column: 2,
        size: { rows: 20, columns: 80 },
      }),
    );
    expect(provider.getSnapshot()).toMatchObject({
      status: "ready",
      providerStatus: "ready",
      filePath: "target.txt",
      absolutePath: workspacePath("target.txt"),
      dirty: false,
      provider: { kind: "neovim" },
      position: { line: 2, column: 4 },
    });
    expect(provider.getSnapshot().terminal?.lines[1]).toContain("alpha");
    expect(provider.getSnapshot().buffers).toContainEqual(
      expect.objectContaining({
        handle: 1,
        changedtick: 1,
        current: true,
      }),
    );
    expect(provider.getVisibleLines()).toEqual([]);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    harness.emitGrid("after unsubscribe");
    expect(listener).toHaveBeenCalledTimes(listener.mock.calls.length);
  });

  it("starts embedded Neovim with the current BUFFER pane size", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);

    provider.resize({ rows: 9, columns: 44 });
    await provider.open({ filePath: "target.txt" });

    expect(harness.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        size: { rows: 9, columns: 44 },
      }),
    );
  });

  it("keeps an early NORMAL frame loading until the startup session can receive input", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    let onSnapshot:
      | StartEmbeddedNeovimOptions["onSnapshot"]
      | null = null;
    const harness = createHarness({
      startSession: vi.fn((options: StartEmbeddedNeovimOptions) => {
        onSnapshot = options.onSnapshot;
        return pending.promise;
      }),
    });
    const provider = new NeovimBufferProvider(harness.options);

    const opening = provider.open({ filePath: "target.txt" });
    await flush();
    const startupFrame = {
      ...createNeovimRenderSnapshot(20, 80),
      lines: ["", "    alpha", ""],
      cursor: { row: 1, column: 4, grid: 1 },
      mode: "normal",
    };
    onSnapshot?.(startupFrame);

    expect(provider.getSnapshot()).toMatchObject({
      status: "loading",
      providerStatus: "loading",
      terminal: {
        mode: "normal",
        lines: startupFrame.lines,
      },
    });
    expect(
      provider.handleInput({
        input: ":",
        key: baseKey(),
        context: { rows: 20, columns: 80 },
      }),
    ).toBe(false);
    expect(harness.session.input).not.toHaveBeenCalled();

    pending.resolve(harness.session);
    await opening;
    expect(provider.getSnapshot()).toMatchObject({
      status: "ready",
      providerStatus: "ready",
    });

    expect(
      provider.handleInput({
        input: ":",
        key: baseKey(),
        context: { rows: 20, columns: 80 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith(":");
  });

  it("runs user init once and retries the real startup clean when auto mode fails safely", async () => {
    const harness = createHarness();
    harness.startSession.mockRejectedValueOnce(new Error("user init boom"));
    const provider = new NeovimBufferProvider({
      ...harness.options,
      discovery: {
        ...usableDiscovery,
        args: ["--embed"],
        useUserInit: true,
        fallback: {
          args: ["--embed", "--clean"],
          useUserInit: false,
        },
      },
    });

    await provider.open({ filePath: "target.txt" });

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[0]?.[0].args).toEqual(["--embed"]);
    expect(harness.startSession.mock.calls[1]?.[0].args).toEqual([
      "--embed",
      "--clean",
    ]);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      providerMessage:
        "User Neovim init failed; BUFFER restarted with a clean init.",
    });
  });

  it("normalizes integration intent paths through the controller into attachment commands", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const selectionFactory = vi.fn(async () => ({
      kind: "neovim" as const,
      provider,
      discovery: usableDiscovery,
    }));
    const controller = new BufferProviderController(selectionFactory);
    const commands: ReturnType<typeof bufferIntegrationIntentCommand>[] = [];
    const unsubscribe = controller.subscribeIntegrationIntents((intent) => {
      commands.push(bufferIntegrationIntentCommand(intent));
    });

    try {
      await controller.open("target.txt", 1);

      harness.emitIntegrationIntent(
        integrationIntent(workspacePath("src", "nested", "app.ts")),
      );
      harness.emitIntegrationIntent(
        integrationIntent(outsidePath("shared", "app.ts")),
      );
      harness.emitIntegrationIntent(integrationIntent("", 29));

      expect(commands).toHaveLength(3);
      expect(commands[0]).toMatchObject({
        type: "handoffToComposer",
        attachment: {
          id: expect.any(String),
          kind: "editor-selection",
          path: "src/nested/app.ts",
          label: "src/nested/app.ts:4-6",
          content: "selected source",
          dirty: true,
        },
      });
      expect(commands[1]).toMatchObject({
        type: "handoffToComposer",
        attachment: {
          id: expect.any(String),
          path: normalizedTestPath(outsidePath("shared", "app.ts")),
          label: `${normalizedTestPath(outsidePath("shared", "app.ts"))}:4-6`,
        },
      });
      expect(commands[2]).toMatchObject({
        type: "handoffToComposer",
        attachment: {
          id: expect.any(String),
          label: "[No Name]:4-6",
          content: "selected source",
          dirty: true,
        },
      });
      const attachmentIds = commands.map((command) =>
        command.type === "handoffToComposer" ? command.attachment.id : "",
      );
      expect(attachmentIds[0]).toMatch(
        /^editor-selection:src\/nested\/app\.ts:4:2:6:8:17:[a-f0-9]{64}$/u,
      );
      expect(attachmentIds[1]).toContain(
        `editor-selection:${normalizedTestPath(outsidePath("shared", "app.ts"))}:4:2:6:8:17:`,
      );
      expect(attachmentIds[1]).toMatch(/:[a-f0-9]{64}$/u);
      expect(attachmentIds[2]).toMatch(
        /^editor-selection:buffer-29:4:2:6:8:17:[a-f0-9]{64}$/u,
      );
      expect(commands[2]).not.toHaveProperty("attachment.path");
      expect(selectionFactory).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      await controller.cleanup();
    }
  });

  it("changes captured attachment identity after an embedded-process restart", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const ids: string[] = [];
    const unsubscribe = provider.subscribeIntegrationIntents((intent) => {
      const command = bufferIntegrationIntentCommand(intent);
      if (command.type === "handoffToComposer") {
        ids.push(command.attachment.id);
      }
    });

    try {
      await provider.open({ filePath: "target.txt" });
      harness.emitIntegrationIntent(
        integrationIntent(workspacePath("target.txt")),
      );
      harness.emitExit();
      await provider.open({ filePath: "target.txt" });
      harness.emitIntegrationIntent(
        integrationIntent(workspacePath("target.txt")),
      );

      expect(ids).toHaveLength(2);
      expect(ids[1]).not.toBe(ids[0]);
      expect(ids[0]).toMatch(/:[a-f0-9]{64}$/u);
      expect(ids[1]).toMatch(/:[a-f0-9]{64}$/u);
    } finally {
      unsubscribe();
      await provider.cleanup();
    }
  });

  it("forwards code-prediction capture, staging, clearing, and feedback through the controller", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    const controller = new BufferProviderController(async () => ({
      kind: "neovim" as const,
      provider,
      discovery: usableDiscovery,
    }));
    const feedback: BufferCodePredictionFeedback[] = [];
    const unsubscribe = controller.subscribeCodePredictionFeedback((event) => {
      feedback.push(event);
    });

    await controller.open("target.txt", 1);
    await expect(
      controller.captureCodePredictionContext(),
    ).resolves.toMatchObject({
      bufferHandle: 1,
      path: workspacePath("target.txt"),
      changedtick: 1,
    });
    await expect(
      controller.stageCodePrediction({
        requestId: "prediction-1",
        generation: 3,
        bufferHandle: 1,
        changedtick: 1,
        cursor: { line: 0, byteColumn: 5 },
        text: "value",
        latencyMs: 25,
      }),
    ).resolves.toBe(true);
    await expect(controller.clearCodePrediction("prediction-1")).resolves.toBe(
      true,
    );

    harness.emitCodePredictionFeedback({
      requestId: "prediction-1",
      kind: "accepted",
      acceptedCharacters: 5,
      latencyMs: 25,
    });
    expect(feedback).toEqual([
      {
        requestId: "prediction-1",
        kind: "accepted",
        acceptedCharacters: 5,
        latencyMs: 25,
      },
    ]);

    await controller.cleanup();
    harness.emitCodePredictionFeedback({
      requestId: "prediction-2",
      kind: "dismissed",
    });
    expect(feedback).toHaveLength(1);
    unsubscribe();
  });

  it("captures exact revision-bound workspace buffers through the controller", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    const controller = new BufferProviderController(async () => ({
      kind: "neovim" as const,
      provider,
      discovery: usableDiscovery,
    }));

    await controller.open("target.txt", 1);
    harness.mutateBuffer(workspacePath("other.ts"));
    harness.setEndOfLine(false, workspacePath("other.ts"));
    harness.mutateBuffer(outsidePath("ignored.ts"));
    const textByHandle = new Map([
      [1, "target exact\n"],
      [2, "other exact"],
      [4, "late exact\r\n"],
    ]);
    let readCount = 0;
    harness.setBufferTextReader(async (handle) => {
      readCount += 1;
      // Make the first two-manifest capture stale. The provider must discard
      // those reads and retry against one stable changedtick/dirty manifest.
      if (readCount === 1) {
        harness.mutateBuffer(workspacePath("late.ts"));
      }
      return textByHandle.get(handle) ?? "outside";
    });
    harness.session.inspectBuffers.mockClear();

    await expect(controller.captureWorkspaceBuffers()).resolves.toEqual([
      {
        path: workspacePath("late.ts"),
        bufferHandle: 4,
        changedtick: 1,
        endOfLine: true,
        dirty: true,
        content: "late exact\r\n",
      },
      {
        path: workspacePath("other.ts"),
        bufferHandle: 2,
        changedtick: 1,
        endOfLine: false,
        dirty: true,
        content: "other exact",
      },
      {
        path: workspacePath("target.txt"),
        bufferHandle: 1,
        changedtick: 1,
        endOfLine: true,
        dirty: false,
        content: "target exact\n",
      },
    ]);
    expect(harness.session.inspectBuffers).toHaveBeenCalledTimes(4);

    await controller.cleanup();
  });

  it("authorizes only exact full-buffer workspace write destinations", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
      requireWorkspaceWriteAuthority: true,
    });
    const authority = vi.fn(
      async (): Promise<BufferWorkspaceWriteDecision> => ({
        allowed: true,
      }),
    );
    provider.setWorkspaceWriteAuthorityHandler(authority);
    await provider.open({ filePath: "target.txt" });

    expect(harness.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ requireWorkspaceWriteAuthority: true }),
    );
    const exact = workspaceWriteRequest({
      path: workspacePath("target.txt"),
      sourcePath: workspacePath("target.txt"),
      kind: "buffer",
    });
    await expect(harness.requestWorkspaceWrite(exact)).resolves.toEqual({
      allowed: true,
    });
    expect(authority).toHaveBeenLastCalledWith(exact);

    await expect(
      harness.requestWorkspaceWrite(
        workspaceWriteRequest({
          path: workspacePath("range-copy.txt"),
          sourcePath: workspacePath("target.txt"),
          kind: "file",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("alternate-path"),
    });
    await expect(
      harness.requestWorkspaceWrite(
        workspaceWriteRequest({
          path: workspacePath("append.txt"),
          sourcePath: workspacePath("target.txt"),
          kind: "append",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("append writes"),
    });
    expect(authority).toHaveBeenCalledTimes(1);

    // :saveas changes the named buffer before BufWritePre, so its source and
    // destination are the same exact new path and remain supported.
    const saveAs = workspaceWriteRequest({
      path: workspacePath("renamed.txt"),
      sourcePath: workspacePath("renamed.txt"),
      kind: "buffer",
    });
    await expect(harness.requestWorkspaceWrite(saveAs)).resolves.toEqual({
      allowed: true,
    });
    expect(authority).toHaveBeenCalledTimes(2);

    await provider.cleanup();
  });

  it("retries workspace capture when only final-line-ending state changes", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    await provider.open({ filePath: "target.txt" });
    let reads = 0;
    harness.setBufferTextReader(async () => {
      reads += 1;
      if (reads === 1) harness.setEndOfLine(false);
      return "target exact";
    });
    harness.session.inspectBuffers.mockClear();

    await expect(provider.captureWorkspaceBuffers()).resolves.toEqual([
      {
        path: workspacePath("target.txt"),
        bufferHandle: 1,
        changedtick: 1,
        endOfLine: false,
        dirty: false,
        content: "target exact",
      },
    ]);
    expect(harness.session.inspectBuffers).toHaveBeenCalledTimes(4);
    await provider.cleanup();
  });

  it("never promotes a named nofile scratch buffer to a host file target", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    harness.session.inspectBuffers.mockResolvedValueOnce({
      activeBufferHandle: 1,
      buffers: [
        {
          handle: 1,
          name: workspacePath("target.txt"),
          listed: true,
          loaded: true,
          modified: true,
          current: true,
          bufferType: "",
          modifiable: true,
          readOnly: false,
          saveable: true,
        },
        {
          handle: 91,
          name: workspacePath("[disk] target.txt"),
          listed: false,
          loaded: true,
          modified: false,
          current: false,
          bufferType: "nofile",
          modifiable: false,
          readOnly: true,
          saveable: false,
        },
      ],
    });
    await provider.open({ filePath: "target.txt" });

    expect(provider.getSnapshot()).toMatchObject({
      filePath: "target.txt",
      absolutePath: workspacePath("target.txt"),
      activeBufferHandle: 1,
    });
    expect(
      provider.getSnapshot().buffers.find((buffer) => buffer.handle === 91),
    ).toMatchObject({
      filePath: null,
      absolutePath: null,
      listed: false,
      bufferType: "nofile",
      saveable: false,
    });
  });

  it("maps recovery to the active file and never deletes sibling swap files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-provider-recovery-"));
    const swap = join(root, "swap");
    const undo = join(root, "undo");
    const copies = join(root, "copies");
    await Promise.all([mkdir(swap), mkdir(undo), mkdir(copies)]);
    const firstSwap = join(swap, "%workspace%first.txt.swp");
    const secondSwap = join(swap, "%workspace%second.txt.swp");
    await Promise.all([
      writeFile(firstSwap, "first recovery"),
      writeFile(secondSwap, "second recovery"),
    ]);
    const recovery: EmbeddedNeovimRecoveryInfo = {
      root,
      swap,
      undo,
      copies,
      shada: join(root, "main.shada"),
      manifest: join(root, "recovery.json"),
      workspaceRoot: TEST_WORKSPACE_ROOT,
      workspaceHash: "test",
      swapFiles: [firstSwap, secondSwap],
    };
    const harness = createHarness({ recovery });
    const provider = new NeovimBufferProvider(harness.options);

    try {
      await provider.open({ filePath: "first.txt" });
      harness.emitRecovery({
        swapFile: firstSwap,
        filePath: workspacePath("first.txt"),
      });
      expect(provider.getSnapshot().recovery).toMatchObject({
        status: "pending",
        swapFiles: [firstSwap],
      });

      harness.session.finishRecovery.mockRejectedValueOnce(
        new Error("replacement preserve failed"),
      );
      await expect(provider.resolveRecovery("recover")).resolves.toEqual({
        ok: false,
        reason: "replacement preserve failed",
      });
      await expect(readFile(firstSwap, "utf8")).resolves.toBe("first recovery");
      await expect(readFile(secondSwap, "utf8")).resolves.toBe(
        "second recovery",
      );

      harness.session.finishRecovery.mockResolvedValueOnce(null);
      await expect(provider.resolveRecovery("recover")).resolves.toEqual({
        ok: false,
        reason: "Neovim did not confirm its post-recovery swap state.",
      });
      await expect(readFile(firstSwap, "utf8")).resolves.toBe("first recovery");
      await expect(readFile(secondSwap, "utf8")).resolves.toBe(
        "second recovery",
      );
      harness.session.applyRecovery.mockClear();

      harness.session.finishRecovery.mockResolvedValueOnce(null);
      await expect(provider.resolveRecovery("save-copy")).resolves.toEqual({
        ok: false,
        reason: "Neovim did not confirm its post-recovery swap state.",
      });
      await expect(readFile(firstSwap, "utf8")).resolves.toBe("first recovery");
      await expect(readFile(secondSwap, "utf8")).resolves.toBe(
        "second recovery",
      );
      harness.session.applyRecovery.mockClear();

      harness.session.openFile.mockClear();
      await provider.open({ filePath: "second.txt" });
      expect(provider.getSnapshot().recovery).toMatchObject({
        status: "pending",
        swapFiles: [firstSwap],
      });
      expect(harness.session.openFile).not.toHaveBeenCalledWith(
        workspacePath("second.txt"),
        expect.anything(),
        expect.anything(),
      );

      harness.emitRecovery({
        swapFile: secondSwap,
        filePath: workspacePath("second.txt"),
      });
      expect(provider.getSnapshot().recovery).toMatchObject({
        status: "pending",
        swapFiles: [firstSwap],
      });

      let releaseRecoveryOpen = (): void => {};
      const recoveryOpenGate = new Promise<void>((resolve) => {
        releaseRecoveryOpen = resolve;
      });
      harness.session.openFile.mockImplementationOnce(async () => {
        await recoveryOpenGate;
        return true;
      });
      const discard = provider.resolveRecovery("discard");
      await flush();
      await expect(provider.resolveRecovery("recover")).resolves.toEqual({
        ok: false,
        reason: "An embedded Neovim recovery action is already in progress.",
      });
      await provider.open({ filePath: "second.txt" });
      await expect(provider.close()).resolves.toBe(false);
      releaseRecoveryOpen();
      await expect(discard).resolves.toEqual({ ok: true });
      expect(harness.session.openFile).toHaveBeenCalledWith(
        workspacePath("first.txt"),
        1,
        0,
      );
      await expect(readFile(firstSwap, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(secondSwap, "utf8")).resolves.toBe(
        "second recovery",
      );
      expect(provider.getSnapshot().recovery).toMatchObject({
        status: "pending",
        swapFiles: [secondSwap],
      });
      expect(harness.session.applyRecovery).not.toHaveBeenCalled();
    } finally {
      await provider.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an unchanged disk baseline after recovery so the recovered buffer can save", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-provider-recovery-save-"));
    const swap = join(root, "swap");
    const undo = join(root, "undo");
    const copies = join(root, "copies");
    await Promise.all([mkdir(swap), mkdir(undo), mkdir(copies)]);
    const swapFile = join(swap, "%workspace%target.txt.swp");
    await writeFile(swapFile, "recovery bytes");
    const recovery: EmbeddedNeovimRecoveryInfo = {
      root,
      swap,
      undo,
      copies,
      shada: join(root, "main.shada"),
      manifest: join(root, "recovery.json"),
      workspaceRoot: TEST_WORKSPACE_ROOT,
      workspaceHash: "test",
      swapFiles: [swapFile],
    };
    const harness = createHarness({ recovery });
    const provider = new NeovimBufferProvider(harness.options);

    try {
      await provider.open({ filePath: "target.txt" });
      harness.emitRecovery({
        swapFile,
        filePath: workspacePath("target.txt"),
      });
      harness.setDirty(true);
      harness.setBufferTextReader(async () => "recovered alpha\n");

      await expect(provider.resolveRecovery("recover")).resolves.toEqual({
        ok: true,
      });
      await expect(provider.save()).resolves.toBe(true);
      expect(harness.session.saveBuffer).toHaveBeenCalledWith(1, false);
      expect(provider.getSnapshot()).toMatchObject({
        providerStatus: "ready",
        conflictKind: null,
      });
    } finally {
      await provider.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes printable input, paste, resize, focus, undo, redo, and inert inline movements to Neovim", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    expect(
      provider.handleInput({
        input: "i",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenLastCalledWith("i");

    harness.session.isDirty.mockClear();
    expect(
      provider.handleInput({
        input: "o",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    expect(
      provider.handleInput({
        input: "K",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("o");
    expect(harness.session.input).toHaveBeenCalledWith("K");
    expect(harness.session.isDirty).not.toHaveBeenCalled();

    harness.session.input.mockClear();
    harness.session.paste.mockClear();
    expect(
      provider.handleInput({
        input: "hello",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("hello");
    expect(harness.session.paste).not.toHaveBeenCalled();

    harness.session.input.mockClear();
    harness.session.paste.mockClear();
    expect(
      provider.handleInput({
        input: "hello",
        key: baseKey(),
        isPaste: true,
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.paste).toHaveBeenCalledWith("hello");
    expect(harness.session.input).not.toHaveBeenCalled();

    expect(
      provider.handleInput({
        input: "",
        key: { ...baseKey(), escape: true },
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("<Esc>");

    provider.resize({ rows: 1.9, columns: 2.8 });
    provider.focus(true);
    expect(provider.click(2, 5)).toBe(true);
    await flush();
    expect(harness.session.resize).toHaveBeenCalledWith({
      rows: 1,
      columns: 2,
    });
    expect(harness.session.focus).toHaveBeenCalledWith(true);
    expect(harness.session.click).toHaveBeenCalledWith(2, 5);

    harness.session.click.mockRejectedValueOnce(new Error("click failed"));
    expect(provider.click(3, 6)).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "click failed",
    });

    harness.session.click.mockRejectedValueOnce("click string failed");
    expect(provider.click(4, 7)).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "click string failed",
    });

    harness.session.resize.mockRejectedValueOnce(new Error("resize failed"));
    provider.resize({ rows: 3, columns: 4 });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "resize failed",
    });

    harness.session.resize.mockRejectedValueOnce("resize string failed");
    provider.resize({ rows: 5, columns: 6 });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "resize string failed",
    });

    harness.session.focus.mockRejectedValueOnce(new Error("focus failed"));
    provider.focus(false);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "focus failed",
    });

    harness.session.focus.mockRejectedValueOnce("focus string failed");
    provider.focus(false);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "focus string failed",
    });

    expect(provider.undo()).toBe(true);
    expect(provider.redo()).toBe(true);
    await provider.revert();
    expect(harness.session.input).toHaveBeenCalledWith("u");
    expect(harness.session.input).toHaveBeenCalledWith("<C-r>");
    expect(harness.session.input).toHaveBeenCalledWith("<Esc>:edit!<CR>");
    expect(provider.move("down")).toBe(false);
    await expect(provider.requestHover()).resolves.toBeNull();
    await expect(provider.goToDefinition()).resolves.toBe(false);

    harness.session.input.mockRejectedValueOnce(
      new Error("undo transport failed"),
    );
    expect(provider.undo()).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "undo transport failed",
    });
  });

  it("refuses in-flight agent saves, surfaces session save failures, and recovers after a clean save", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    await expect(provider.save({ hasInFlightAgent: true })).resolves.toBe(
      false,
    );
    expect(provider.getSnapshot()).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("agent"),
    });

    harness.session.save.mockRejectedValueOnce(new Error("write failed"));
    await expect(provider.save()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      status: "error",
      error: "write failed",
    });

    harness.session.save.mockResolvedValueOnce(false);
    await expect(provider.save()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      status: "error",
      error: "write failed",
    });

    harness.setDirty(false);
    await expect(provider.save({ force: true })).resolves.toBe(true);
    expect(harness.session.save).toHaveBeenLastCalledWith(true);
    expect(provider.getSnapshot()).toMatchObject({
      status: "ready",
      dirty: false,
      error: null,
    });
  });

  it("does not erase an actionable error when a closed session cannot revert", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.emitError(new Error("cleanup ownership retained"));
    harness.session.input.mockResolvedValueOnce(false);

    await expect(provider.revert()).resolves.toBeUndefined();

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "cleanup ownership retained",
    });
  });

  it("reports disk read conflicts and tolerates refresh failures after a force save", async () => {
    const openedSnapshot = snapshotFor("target.txt", 1);
    const conflictRead = vi
      .fn()
      .mockResolvedValueOnce(openedSnapshot)
      .mockResolvedValueOnce(openedSnapshot)
      .mockRejectedValueOnce(new Error("stat failed"));
    const conflictHarness = createHarness({ readFileSnapshot: conflictRead });
    const conflictProvider = new NeovimBufferProvider(conflictHarness.options);
    await conflictProvider.open({ filePath: "target.txt" });

    await expect(conflictProvider.save()).resolves.toBe(false);
    expect(conflictProvider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      error: expect.stringContaining("changed on disk"),
    });
    expect(conflictHarness.session.save).not.toHaveBeenCalled();

    const refreshRead = vi
      .fn()
      .mockResolvedValueOnce(openedSnapshot)
      .mockResolvedValueOnce(openedSnapshot)
      .mockRejectedValueOnce(new Error("refresh failed"));
    const refreshHarness = createHarness({ readFileSnapshot: refreshRead });
    const refreshProvider = new NeovimBufferProvider(refreshHarness.options);
    await refreshProvider.open({ filePath: "target.txt" });

    await expect(refreshProvider.save({ force: true })).resolves.toBe(true);
    expect(refreshHarness.session.save).toHaveBeenCalledWith(true);
    expect(refreshProvider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      error: null,
    });
  });

  it("leaves snapshot refresh alone when a provider snapshot has no display path", async () => {
    const harness = createHarness({
      readFileSnapshot: vi.fn(async () => ({
        ...snapshotFor("target.txt", 1),
        filePath: "",
      })),
    });
    const provider = new NeovimBufferProvider(harness.options);

    await provider.open({ filePath: "target.txt" });

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "",
    });
  });

  it("keeps dirty sessions alive on normal close and cleans once on discard cleanup", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    harness.session.quit.mockResolvedValueOnce({
      closed: false,
      reason: "dirty buffer",
    });
    await expect(provider.close()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      status: "conflict",
      error: "dirty buffer",
    });

    harness.session.quit.mockResolvedValueOnce({ closed: true });
    await expect(provider.close({ discard: true })).resolves.toBe(true);
    expect(provider.getSnapshot()).toMatchObject({
      status: "idle",
      dirty: false,
    });

    await provider.cleanup();
    await provider.cleanup();
    expect(harness.session.cleanup).not.toHaveBeenCalled();

    await expect(provider.close()).resolves.toBe(true);
    expect(provider.getSnapshot().providerStatus).toBe("idle");
  });

  it("keeps one workspace session and retains dirty hidden buffers across navigation", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.setDirty(true);
    harness.emitDirty(true);

    await expect(
      provider.open({ filePath: "next.txt" }),
    ).resolves.toBeUndefined();

    expect(harness.session.quit).not.toHaveBeenCalled();
    expect(harness.session.cleanup).not.toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
      dirty: true,
      dirtyBufferCount: 1,
    });
    expect(provider.getSnapshot().buffers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: workspacePath("target.txt"),
          modified: true,
        }),
        expect.objectContaining({
          name: workspacePath("next.txt"),
          current: true,
        }),
      ]),
    );

    await expect(provider.saveAll({ force: true })).resolves.toMatchObject({
      saved: true,
    });
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
      dirty: false,
    });
  });

  it.each(["changedtick", "new-dirty-buffer"] as const)(
    "fails Save All before writing when the preflighted %s set changes",
    async (race) => {
      let mutateDuringPreflight: (() => void) | null = null;
      const readFileSnapshot = vi.fn(async (filePath: string) => {
        const mutate = mutateDuringPreflight;
        mutateDuringPreflight = null;
        mutate?.();
        return {
          filePath,
          absolutePath: filePath,
          content: "alpha\n",
          mtimeMs: 1,
          size: 6,
          encoding: "utf8" as const,
          lineEndings: "LF" as const,
        };
      });
      const harness = createHarness({ readFileSnapshot });
      const provider = new NeovimBufferProvider(harness.options);
      await provider.open({ filePath: "target.txt" });
      harness.setDirty(true);
      mutateDuringPreflight = () => {
        harness.mutateBuffer(
          race === "changedtick" ? undefined : workspacePath("unreviewed.txt"),
        );
      };

      await expect(provider.saveAll()).resolves.toMatchObject({
        saved: false,
        reason: expect.stringMatching(
          race === "changedtick"
            ? /changed during Save All before it could be written/u
            : /dirty-buffer set changed during Save All/u,
        ),
      });

      expect(harness.session.saveBuffer).not.toHaveBeenCalled();
      expect(harness.session.saveAll).not.toHaveBeenCalled();
      expect(provider.getSnapshot()).toMatchObject({
        providerStatus: "conflict",
        dirty: true,
      });
    },
  );

  it("binds Discard All confirmation to the exact dirty manifest", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.setDirty(true);

    const confirmation = await provider.prepareDiscardAll();
    expect(confirmation).not.toBeNull();
    harness.mutateBuffer(workspacePath("unreviewed.txt"));

    await expect(provider.discardAll(confirmation ?? undefined)).resolves.toBe(
      false,
    );
    expect(harness.session.discardAll).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
    });
    await expect(provider.inspectDirtyBuffers()).resolves.toHaveLength(2);
  });

  it("fails Discard All when a buffer becomes dirty before post-discard confirmation", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.setDirty(true);
    const confirmation = await provider.prepareDiscardAll();
    expect(confirmation).not.toBeNull();
    harness.session.discardAll.mockImplementationOnce(async () => {
      harness.setDirty(false);
      harness.mutateBuffer(workspacePath("late-edit.txt"));
      return true;
    });

    await expect(provider.discardAll(confirmation ?? undefined)).resolves.toBe(
      false,
    );
    expect(provider.getSnapshot().dirty).toBe(true);
    expect(provider.getSnapshot().providerStatus).toBe("conflict");
  });

  it("blocks editor input and writes while a project path mutation owns the workspace", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    expect(provider.beginProjectPathMutation()).toBe(true);
    expect(provider.beginProjectPathMutation()).toBe(false);
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(false);
    expect(provider.click(1, 1)).toBe(false);
    await expect(provider.save()).resolves.toBe(false);
    await expect(provider.saveBuffer(1)).resolves.toBe(false);
    await expect(provider.selectBuffer(1)).resolves.toBe(false);
    expect(provider.undo()).toBe(false);
    expect(provider.redo()).toBe(false);
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    await expect(provider.close()).resolves.toBe(false);
    expect(harness.session.input).not.toHaveBeenCalled();
    expect(harness.session.click).not.toHaveBeenCalled();
    expect(harness.session.saveBuffer).not.toHaveBeenCalled();
    expect(harness.session.quit).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();

    provider.endProjectPathMutation();
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("x");
  });

  it("rebases active and hidden file buffers by stable handle after a directory rename", async () => {
    const readFileSnapshot = vi.fn(async (filePath: string) => {
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : workspacePath(filePath);
      return {
        ...snapshotFor(relative(TEST_WORKSPACE_ROOT, absolutePath), 1),
        absolutePath,
      };
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    await provider.open({ filePath: "src/active.ts" });
    await provider.open({ filePath: "src/hidden.ts" });
    const before = provider
      .getSnapshot()
      .buffers.filter((buffer) =>
        normalizedTestPath(buffer.filePath ?? "").startsWith("src/"),
      )
      .map((buffer) => ({
        handle: buffer.handle,
        filePath: normalizedTestPath(buffer.filePath!),
      }));

    await expect(provider.synchronizePathRename("src", "lib")).resolves.toEqual(
      {
        ok: true,
        affectedBufferHandles: before.map((buffer) => buffer.handle),
      },
    );

    expect(harness.session.rebaseFileBuffers).toHaveBeenCalledWith(
      before.map((buffer) => ({
        handle: buffer.handle,
        fromPath: workspacePath(buffer.filePath!),
        toPath: workspacePath("lib", buffer.filePath!.slice("src/".length)),
      })),
    );
    expect(provider.getSnapshot().providerStatus).toBe("ready");
    expect(normalizedTestPath(provider.getSnapshot().filePath ?? "")).toBe(
      "lib/hidden.ts",
    );
    expect(
      provider.getSnapshot().buffers.map((buffer) => ({
        ...buffer,
        filePath:
          buffer.filePath === null ? null : normalizedTestPath(buffer.filePath),
      })),
    ).toEqual(
      expect.arrayContaining(
        before.map((buffer) =>
          expect.objectContaining({
            handle: buffer.handle,
            filePath: `lib/${buffer.filePath?.slice("src/".length)}`,
          }),
        ),
      ),
    );
    expect(
      provider
        .getSnapshot()
        .buffers.some((buffer) =>
          normalizedTestPath(buffer.filePath ?? "").startsWith("src/"),
        ),
    ).toBe(false);
  });

  it("rebases physical Neovim buffer names opened through a workspace alias", async () => {
    if (process.platform === "win32") return;
    const sandbox = await mkdtemp(join(tmpdir(), "agenc-nvim-path-alias-"));
    const physicalRoot = join(sandbox, "physical");
    const workspaceAlias = join(sandbox, "workspace");
    const sourceDirectory = join(physicalRoot, "src");
    const destinationDirectory = join(physicalRoot, "lib");
    await mkdir(sourceDirectory, { recursive: true });
    await symlink(physicalRoot, workspaceAlias, "dir");
    await Promise.all([
      writeFile(join(sourceDirectory, "active.ts"), "active\n", "utf8"),
      writeFile(join(sourceDirectory, "hidden.ts"), "hidden\n", "utf8"),
    ]);

    const readFileSnapshot = vi.fn(async (filePath: string) => ({
      filePath,
      absolutePath: isAbsolute(filePath)
        ? filePath
        : join(workspaceAlias, filePath),
      content: "alpha\n",
      mtimeMs: 1,
      size: 6,
      encoding: "utf8" as const,
      lineEndings: "LF" as const,
    }));
    const harness = createHarness({ readFileSnapshot });
    const originalInspect =
      harness.session.inspectBuffers.getMockImplementation();
    if (!originalInspect) throw new Error("missing Neovim manifest fixture");
    const rebasedNames = new Map<number, string>();
    harness.session.inspectBuffers.mockImplementation(async () => {
      const manifest = await originalInspect();
      return {
        ...manifest,
        buffers: manifest.buffers.map((buffer) => ({
          ...buffer,
          // Match Neovim on Darwin: the editor reports the physical
          // `/private/tmp`-style name, not the alias used to open the file.
          name:
            rebasedNames.get(buffer.handle) ?? canonicalNeovimPath(buffer.name),
        })),
      };
    });
    harness.session.rebaseFileBuffers.mockImplementation(async (changes) => {
      for (const change of changes) {
        rebasedNames.set(change.handle, change.toPath);
      }
    });
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: workspaceAlias,
    });

    try {
      await provider.open({ filePath: "src/active.ts" });
      await provider.open({ filePath: "src/hidden.ts" });
      await rename(sourceDirectory, destinationDirectory);

      const result = await provider.synchronizePathRename("src", "lib");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.affectedBufferHandles).toHaveLength(2);
      expect(harness.session.rebaseFileBuffers).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            fromPath: canonicalNeovimPath(
              join(physicalRoot, "src", "active.ts"),
            ),
            toPath: canonicalNeovimPath(join(physicalRoot, "lib", "active.ts")),
          }),
          expect.objectContaining({
            fromPath: canonicalNeovimPath(
              join(physicalRoot, "src", "hidden.ts"),
            ),
            toPath: canonicalNeovimPath(join(physicalRoot, "lib", "hidden.ts")),
          }),
        ]),
      );
      expect(provider.getSnapshot().buffers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filePath: "lib/active.ts" }),
          expect.objectContaining({ filePath: "lib/hidden.ts" }),
        ]),
      );
    } finally {
      await provider.cleanup();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("unloads every active or hidden clean buffer after a directory delete", async () => {
    const readFileSnapshot = vi.fn(async (filePath: string) => {
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : workspacePath(filePath);
      return {
        ...snapshotFor(relative(TEST_WORKSPACE_ROOT, absolutePath), 1),
        absolutePath,
      };
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider({
      ...harness.options,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    await provider.open({ filePath: "src/active.ts" });
    await provider.open({ filePath: "src/hidden.ts" });
    const affected = provider
      .getSnapshot()
      .buffers.filter((buffer) =>
        normalizedTestPath(buffer.filePath ?? "").startsWith("src/"),
      );

    await expect(provider.synchronizePathDelete("src")).resolves.toEqual({
      ok: true,
      affectedBufferHandles: affected.map((buffer) => buffer.handle),
    });

    expect(harness.session.deleteFileBuffers).toHaveBeenCalledWith(
      affected.map((buffer) => ({
        handle: buffer.handle,
        path: buffer.absolutePath,
      })),
    );
    expect(
      provider
        .getSnapshot()
        .buffers.some((buffer) =>
          normalizedTestPath(buffer.filePath ?? "").startsWith("src/"),
        ),
    ).toBe(false);
    for (const buffer of affected) {
      await expect(provider.selectBuffer(buffer.handle)).resolves.toBe(false);
      await expect(provider.saveBuffer(buffer.handle)).resolves.toBe(false);
    }
  });

  it("does not reset a hidden buffer disk baseline when navigating back to it", async () => {
    let aMtime = 1;
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "a.txt" || path === workspacePath("a.txt")) {
        return snapshotFor("a.txt", aMtime);
      }
      if (path === "b.txt" || path === workspacePath("b.txt")) {
        return snapshotFor("b.txt", 1);
      }
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "a.txt" });
    await provider.open({ filePath: "b.txt" });

    aMtime = 2;
    await provider.open({ filePath: "a.txt" });
    harness.setDirty(true);
    harness.emitDirty(true);

    await expect(provider.save()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      error: expect.stringContaining("changed on disk"),
    });
    expect(harness.session.saveBuffer).not.toHaveBeenCalled();
  });

  it("retains the one-release per-file rollback without weakening dirty safety", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider({
      ...harness.options,
      sessionMode: "file",
    });
    await provider.open({ filePath: "target.txt" });
    harness.setDirty(true);
    harness.emitDirty(true);

    await provider.open({ filePath: "next.txt" });

    expect(harness.session.quit).toHaveBeenCalledWith(false);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      filePath: "target.txt",
      dirty: true,
    });

    harness.setDirty(false);
    await provider.open({ filePath: "next.txt" });
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });
  });

  it("serializes concurrent file navigation and leaves the newest file active", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    const slowNavigation = controlled<boolean>();
    harness.session.openFile.mockImplementationOnce(
      () => slowNavigation.promise,
    );
    const openingSlow = provider.open({ filePath: "slow.txt" });
    await flush();
    const openingNewest = provider.open({ filePath: "newest.txt" });
    await flush();
    expect(harness.session.openFile).toHaveBeenCalledTimes(1);
    slowNavigation.resolve(true);
    await Promise.all([openingSlow, openingNewest]);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.session.openFile).toHaveBeenNthCalledWith(
      2,
      workspacePath("newest.txt"),
      1,
      0,
    );
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "newest.txt",
    });
  });

  it("queues editor input until the requested file owns the workspace", async () => {
    const nextFileRead = controlled<BufferFileSnapshot>();
    const readFileSnapshot = vi.fn(async (filePath: string) => {
      if (filePath === "next.txt") return nextFileRead.promise;
      return snapshotFor(filePath, 1);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    let activePath = workspacePath("target.txt");
    let inputPath: string | null = null;
    harness.session.openFile.mockImplementationOnce(
      async (filePath: string) => {
        activePath = filePath;
        harness.activatePath(filePath);
        return true;
      },
    );
    harness.session.input.mockImplementationOnce(async () => {
      inputPath = activePath;
      return true;
    });

    const openingNext = provider.open({ filePath: "next.txt" });
    await flush();
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(harness.session.input).not.toHaveBeenCalled();

    nextFileRead.resolve(snapshotFor("next.txt", 2));
    await openingNext;
    await flush();

    expect(harness.session.openFile).toHaveBeenCalledWith(
      workspacePath("next.txt"),
      1,
      0,
    );
    expect(harness.session.input).toHaveBeenCalledWith("x");
    expect(inputPath).toBe(workspacePath("next.txt"));
  });

  it("drops queued editor input when a newer file navigation supersedes it", async () => {
    const slowFileRead = controlled<BufferFileSnapshot>();
    const readFileSnapshot = vi.fn(async (filePath: string) => {
      if (filePath === "slow.txt") return slowFileRead.promise;
      return snapshotFor(filePath, 1);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.session.input.mockClear();

    const openingSlow = provider.open({ filePath: "slow.txt" });
    await flush();
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);

    await provider.open({ filePath: "newest.txt" });
    await flush();
    expect(harness.session.input).not.toHaveBeenCalled();

    slowFileRead.resolve(snapshotFor("slow.txt", 2));
    await openingSlow;
    await flush();

    expect(harness.session.input).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "newest.txt",
    });
  });

  it("contains navigation and cleanup failures and retains actionable BUFFER diagnostics", async () => {
    const reopenHarness = createHarness();
    const reopenProvider = new NeovimBufferProvider(reopenHarness.options);
    await reopenProvider.open({ filePath: "target.txt" });
    reopenHarness.session.openFile.mockRejectedValueOnce(
      new Error("navigation failed"),
    );

    await expect(
      reopenProvider.open({ filePath: "next.txt" }),
    ).resolves.toBeUndefined();

    expect(reopenHarness.startSession).toHaveBeenCalledTimes(1);
    expect(reopenProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error: "navigation failed",
    });
    await expect(
      reopenProvider.open({ filePath: "next.txt" }),
    ).resolves.toBeUndefined();
    expect(reopenHarness.startSession).toHaveBeenCalledTimes(1);
    expect(reopenProvider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });

    const closeHarness = createHarness();
    const closeProvider = new NeovimBufferProvider(closeHarness.options);
    await closeProvider.open({ filePath: "target.txt" });
    closeHarness.session.quit.mockRejectedValueOnce(
      new Error("process tree survived"),
    );

    await expect(closeProvider.close({ discard: true })).resolves.toBe(false);

    expect(closeProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error:
        "Embedded Neovim cleanup failed while closing BUFFER: process tree survived",
    });
    await expect(closeProvider.close({ discard: true })).resolves.toBe(true);
    expect(closeProvider.getSnapshot().providerStatus).toBe("idle");

    const cleanupHarness = createHarness();
    const cleanupProvider = new NeovimBufferProvider(cleanupHarness.options);
    await cleanupProvider.open({ filePath: "target.txt" });
    cleanupHarness.session.cleanup.mockRejectedValueOnce(
      new Error("process tree survived"),
    );

    await expect(cleanupProvider.cleanup()).rejects.toThrow(
      "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    );
    expect(cleanupProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error:
        "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    });
    await expect(cleanupProvider.cleanup()).resolves.toBeUndefined();
    expect(cleanupProvider.getSnapshot().providerStatus).toBe("idle");
  });

  it("does not acknowledge abnormal cleanup after an unproven process exit", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.emitDirty(true);
    await vi.waitFor(() => {
      expect(provider.getSnapshot().dirty).toBe(true);
    });

    harness.emitExit({
      code: 1,
      signal: null,
      stderrTail: "embedded process failed",
    });

    await expect(provider.cleanup({ preserveRecovery: true })).rejects.toThrow(
      "Embedded Neovim exited before exact dirty-buffer recovery preservation was confirmed.",
    );
    expect(harness.session.cleanup).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
    });
  });

  it("does not let a slow close erase a newer open", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    const closeResult = controlled<{ readonly closed: true }>();
    harness.session.quit.mockImplementationOnce(() => closeResult.promise);

    const closing = provider.close({ discard: true });
    await provider.open({ filePath: "next.txt" });
    closeResult.resolve({ closed: true });

    await expect(closing).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });
  });

  it("does not let slow cleanup reset a newer open", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    const cleanupResult = controlled<void>();
    harness.session.cleanup.mockImplementationOnce(() => cleanupResult.promise);

    const cleaning = provider.cleanup();
    await provider.open({ filePath: "next.txt" });
    cleanupResult.resolve(undefined);
    await cleaning;

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });
  });

  it("accepts a successful close when the same session exits during quit", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.session.quit.mockImplementationOnce(async () => {
      harness.emitExit();
      return { closed: true };
    });

    await expect(provider.close({ discard: true })).resolves.toBe(true);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
  });

  it("guards external editor handoff behind a clean embedded buffer and reloads after a successful handoff", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    const dirtyProbe = controlled<boolean>();
    harness.session.hasUnsavedBuffers.mockImplementation(
      () => dirtyProbe.promise,
    );
    expect(
      provider.handleInput({
        input: "i",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    const immediateHandoff = provider.openExternalEditor();
    expect(launch).not.toHaveBeenCalled();
    dirtyProbe.resolve(true);
    await expect(immediateHandoff).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(provider.getSnapshot().providerStatus).toBe("conflict");

    harness.session.hasUnsavedBuffers.mockRejectedValueOnce(
      new Error("dirty probe unavailable"),
    );
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("dirty probe unavailable"),
    });

    harness.session.hasUnsavedBuffers.mockImplementation(async () => false);
    harness.setDirty(false);
    await expect(provider.save()).resolves.toBe(true);
    await expect(provider.openExternalEditor()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith(workspacePath("target.txt"), 2);
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    launch.mockReturnValueOnce(false);
    const startCountBeforeCancel = harness.startSession.mock.calls.length;
    const cleanupCountBeforeCancel = harness.session.cleanup.mock.calls.length;
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("No external editor"),
    });
    expect(harness.startSession).toHaveBeenCalledTimes(startCountBeforeCancel);
    expect(harness.session.cleanup).toHaveBeenCalledTimes(
      cleanupCountBeforeCancel,
    );
    expect(provider.getSnapshot().filePath).toBe("target.txt");

    launch.mockImplementationOnce(() => {
      throw new Error("launcher crashed");
    });
    const startCountBeforeThrow = harness.startSession.mock.calls.length;
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "launcher crashed",
    });
    expect(harness.startSession).toHaveBeenCalledTimes(startCountBeforeThrow);

    launch.mockImplementationOnce(() => {
      throw "launcher string crashed";
    });
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "launcher string crashed",
    });
  });

  it("allows explicit external editor handoff after embedded Neovim has exited cleanly", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    harness.emitExit();
    await expect(provider.openExternalEditor()).resolves.toBe(true);

    expect(launch).toHaveBeenCalledWith(workspacePath("target.txt"), 2);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
  });

  it("blocks external handoff when a hidden Neovim buffer is modified", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.session.isDirty.mockResolvedValue(false);
    harness.session.hasUnsavedBuffers.mockResolvedValueOnce(true);

    await expect(provider.openExternalEditor()).resolves.toBe(false);

    expect(harness.session.hasUnsavedBuffers).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      dirty: true,
    });
  });

  it("does not hand off a retired file while a newer file is loading", async () => {
    const pendingRead = controlled<BufferFileSnapshot>();
    const launch = vi.fn(() => true);
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "target.txt" || path === workspacePath("target.txt")) {
        return snapshotFor("target.txt", 1);
      }
      if (path === "next.txt") return pendingRead.promise;
      if (path === workspacePath("next.txt")) return snapshotFor("next.txt", 2);
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ launch, readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    const openingNext = provider.open({ filePath: "next.txt" });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "loading",
      filePath: "target.txt",
      absolutePath: workspacePath("target.txt"),
    });

    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    pendingRead.resolve(snapshotFor("next.txt", 2));
    await openingNext;

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });
  });

  it("does not hand off the previous file while a newer navigation is pending", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    const navigationResult = controlled<boolean>();
    harness.session.openFile.mockImplementationOnce(
      async (filePath: string) => {
        const result = await navigationResult.promise;
        if (result) harness.activatePath(filePath);
        return result;
      },
    );

    const openingNext = provider.open({ filePath: "next.txt" });
    await flush();
    expect(harness.session.openFile).toHaveBeenCalledWith(
      workspacePath("next.txt"),
      1,
      0,
    );

    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    navigationResult.resolve(true);
    await openingNext;

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });
  });

  it("cancels a pending open when close wins before the file read resolves", async () => {
    const pendingRead = controlled<BufferFileSnapshot>();
    const harness = createHarness({
      readFileSnapshot: vi.fn(() => pendingRead.promise),
    });
    const provider = new NeovimBufferProvider(harness.options);

    const pendingOpen = provider.open({ filePath: "target.txt" });
    await flush();
    await expect(provider.close()).resolves.toBe(true);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });

    pendingRead.resolve(snapshotFor("target.txt", 1));
    await pendingOpen;

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
  });

  it("surfaces open failures and ignores stale session starts from superseded opens", async () => {
    const first = controlled<EmbeddedNeovimSession>();
    const second = controlled<EmbeddedNeovimSession>();
    const harness = createHarness({
      startSession: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const provider = new NeovimBufferProvider(harness.options);

    const staleOpen = provider.open({ filePath: "target.txt" });
    const activeOpen = provider.open({ filePath: "target.txt" });
    first.resolve(harness.session);
    second.resolve(harness.session);
    await Promise.all([staleOpen, activeOpen]);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot().providerStatus).toBe("ready");

    const failing = createHarness({
      readFileSnapshot: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    const failingProvider = new NeovimBufferProvider(failing.options);
    await failingProvider.open({ filePath: "missing.txt" });
    expect(failingProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "read failed",
    });

    const stringFailing = createHarness({
      readFileSnapshot: vi.fn(async () => {
        throw "read string failed";
      }),
    });
    const stringFailingProvider = new NeovimBufferProvider(
      stringFailing.options,
    );
    await stringFailingProvider.open({ filePath: "missing.txt" });
    expect(stringFailingProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "read string failed",
    });

    const startupFailure = createHarness();
    startupFailure.startSession.mockRejectedValueOnce(
      new Error("startup exited"),
    );
    const recoveringProvider = new NeovimBufferProvider(startupFailure.options);
    await recoveringProvider.open({ filePath: "target.txt" });
    expect(recoveringProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      workspaceAuthorityRequired: false,
      error: "startup exited",
    });
    await recoveringProvider.open({ filePath: "target.txt" });
    expect(recoveringProvider.getSnapshot().providerStatus).toBe("ready");
  });

  it("does not publish a session that exits before startup ownership commits", async () => {
    let returnedSession: EmbeddedNeovimSession | null = null;
    const harness = createHarness({
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onExit();
        return returnedSession as EmbeddedNeovimSession;
      }),
    });
    returnedSession = harness.session;
    const provider = new NeovimBufferProvider(harness.options);

    await provider.open({ filePath: "target.txt" });

    expect(harness.session.cleanup).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      status: "idle",
      providerStatus: "closed",
      filePath: "target.txt",
      providerMessage: "Embedded Neovim exited.",
    });
  });

  it("does not resurrect ready state when the session exits during dirty refresh", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    harness.session.inspectBuffers.mockImplementationOnce(async () => {
      harness.emitExit();
      return { activeBufferHandle: null, buffers: [] };
    });

    await provider.open({ filePath: "target.txt" });

    expect(provider.getSnapshot()).toMatchObject({
      status: "idle",
      providerStatus: "closed",
      filePath: "target.txt",
      providerMessage: "Embedded Neovim exited.",
    });
    await expect(provider.save()).resolves.toBe(false);
  });

  it("does not commit a stale file refresh after a newer open wins", async () => {
    const staleRefresh = controlled<BufferFileSnapshot>();
    const aSnapshot = snapshotFor("a.txt", 1);
    const bSnapshot = {
      ...snapshotFor("b.txt", 2),
      lineEndings: "CRLF" as const,
    };
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "a.txt") return aSnapshot;
      if (path === workspacePath("a.txt")) return staleRefresh.promise;
      if (path === "b.txt" || path === workspacePath("b.txt")) return bSnapshot;
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);

    const staleOpen = provider.open({ filePath: "a.txt" });
    await flush();
    expect(readFileSnapshot).toHaveBeenCalledWith(workspacePath("a.txt"));
    await provider.open({ filePath: "b.txt" });
    staleRefresh.resolve({ ...aSnapshot, encoding: "utf16le" });
    await staleOpen;

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "b.txt",
      encoding: "utf8",
      lineEndings: "CRLF",
    });
    const readsBeforeSave = readFileSnapshot.mock.calls.length;
    await expect(provider.save()).resolves.toBe(true);
    const saveReads = readFileSnapshot.mock.calls
      .slice(readsBeforeSave)
      .map(([path]) => path);
    expect(saveReads).not.toContain(workspacePath("a.txt"));
    expect(saveReads).toContain(workspacePath("b.txt"));
  });

  it("does not redirect a stale save into the newly active buffer", async () => {
    const conflictRead = controlled<BufferFileSnapshot>();
    const aSnapshot = snapshotFor("a.txt", 1);
    const bSnapshot = snapshotFor("b.txt", 2);
    let aAbsoluteReads = 0;
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "a.txt") return aSnapshot;
      if (path === workspacePath("a.txt")) {
        aAbsoluteReads += 1;
        return aAbsoluteReads === 1 ? aSnapshot : conflictRead.promise;
      }
      if (path === "b.txt" || path === workspacePath("b.txt")) return bSnapshot;
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);

    await provider.open({ filePath: "a.txt" });
    const staleSave = provider.save();
    await flush();
    await provider.open({ filePath: "b.txt" });
    conflictRead.resolve(aSnapshot);

    await expect(staleSave).resolves.toBe(false);
    expect(harness.session.saveBuffer).not.toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "b.txt",
    });
  });

  it("disposes a superseded session start before the newer open acquires", async () => {
    const first = controlled<EmbeddedNeovimSession>();
    const second = controlled<EmbeddedNeovimSession>();
    let firstOptions: StartEmbeddedNeovimOptions | null = null;
    const harness = createHarness({
      startSession: vi
        .fn()
        .mockImplementationOnce((options: StartEmbeddedNeovimOptions) => {
          firstOptions = options;
          return first.promise;
        })
        .mockImplementationOnce(() => second.promise),
    });
    const provider = new NeovimBufferProvider(harness.options);
    const staleSession = {
      ...harness.session,
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;
    const activeSession = {
      ...harness.session,
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
      inspectBuffers: vi.fn(async () => ({
        activeBufferHandle: 9,
        buffers: [
          {
            handle: 9,
            name: workspacePath("active.txt"),
            listed: true,
            loaded: true,
            modified: false,
            current: true,
            bufferType: "",
            modifiable: true,
            readOnly: false,
            saveable: true,
          },
        ],
      })),
    } as any as EmbeddedNeovimSession;

    const staleOpen = provider.open({ filePath: "stale.txt" });
    await flush();
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    const activeOpen = provider.open({ filePath: "active.txt" });
    await flush();
    expect(firstOptions?.signal?.aborted).toBe(true);
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    first.resolve(staleSession);
    await flush();
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    second.resolve(activeSession);
    await Promise.all([staleOpen, activeOpen]);

    expect(staleSession.cleanup).toHaveBeenCalledTimes(1);
    expect(activeSession.cleanup).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      filePath: "active.txt",
      providerStatus: "ready",
    });
  });

  it("aborts and joins an in-flight session start before provider cleanup resolves", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    let capturedOptions: StartEmbeddedNeovimOptions | null = null;
    const harness = createHarness({
      startSession: vi.fn((options: StartEmbeddedNeovimOptions) => {
        capturedOptions = options;
        return pending.promise;
      }),
    });
    const provider = new NeovimBufferProvider(harness.options);
    const lateSession = {
      ...harness.session,
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;

    const open = provider.open({ filePath: "target.txt" });
    await flush();
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    let cleanupSettled = false;
    const cleanup = provider.cleanup().finally(() => {
      cleanupSettled = true;
    });
    await flush();

    const startupSignal = (
      capturedOptions as
        | (StartEmbeddedNeovimOptions & {
            readonly signal?: AbortSignal;
          })
        | null
    )?.signal;
    expect(startupSignal?.aborted).toBe(true);
    expect(cleanupSettled).toBe(false);
    pending.resolve(lateSession);
    await Promise.all([open, cleanup]);

    expect(lateSession.cleanup).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
      dirty: false,
    });

    const rejecting = controlled<EmbeddedNeovimSession>();
    const rejectingHarness = createHarness({
      startSession: vi.fn(() => rejecting.promise),
    });
    const rejectingProvider = new NeovimBufferProvider(
      rejectingHarness.options,
    );
    const rejectingOpen = rejectingProvider.open({ filePath: "target.txt" });
    await flush();
    const rejectingCleanup = rejectingProvider.cleanup();
    await flush();
    rejecting.reject(new Error("late startup failure"));
    await Promise.all([rejectingOpen, rejectingCleanup]);

    expect(rejectingProvider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
      error: null,
    });
  });

  it("retains a late startup session when disposal fails and retries cleanup", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    const harness = createHarness({
      startSession: vi.fn(() => pending.promise),
    });
    const lateSession = {
      ...harness.session,
      cleanup: vi
        .fn()
        .mockRejectedValueOnce(new Error("process tree survived"))
        .mockResolvedValue(undefined),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;
    const provider = new NeovimBufferProvider(harness.options);

    const opening = provider.open({ filePath: "target.txt" });
    await flush();
    const firstCleanup = provider.cleanup();
    await flush();
    pending.resolve(lateSession);

    await expect(firstCleanup).rejects.toThrow(
      "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    );
    await opening;
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error:
        "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    });

    await expect(provider.cleanup()).resolves.toBeUndefined();
    expect(lateSession.cleanup).toHaveBeenCalledTimes(2);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
  });

  it("retries typed cleanup ownership after a canceled startup rollback fails", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    const launch = vi.fn(() => true);
    const retryCleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("startup process still alive"))
      .mockResolvedValue(undefined);
    const startupFailure = new NeovimStartupCleanupError(
      new Error("startup superseded"),
      new Error("initial SIGKILL was not observed"),
      retryCleanup,
    );
    const harness = createHarness({
      launch,
      startSession: vi.fn(() => pending.promise),
    });
    const provider = new NeovimBufferProvider(harness.options);

    const opening = provider.open({ filePath: "target.txt" });
    await flush();
    const firstCleanup = provider.cleanup();
    await flush();
    pending.reject(startupFailure);

    await expect(firstCleanup).rejects.toThrow(
      "startup cleanup retry failed: startup process still alive",
    );
    await opening;
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      workspaceAuthorityRequired: true,
      filePath: "target.txt",
    });
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();

    await expect(provider.cleanup()).resolves.toBeUndefined();
    expect(retryCleanup).toHaveBeenCalledTimes(2);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
    });
  });

  it("ignores stale Neovim callbacks after cleanup supersedes a starting session", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    let capturedOptions: StartEmbeddedNeovimOptions | null = null;
    const harness = createHarness({
      startSession: vi.fn((options: StartEmbeddedNeovimOptions) => {
        capturedOptions = options;
        return pending.promise;
      }),
    });
    const provider = new NeovimBufferProvider(harness.options);

    const open = provider.open({ filePath: "target.txt" });
    await flush();
    const cleanup = provider.cleanup();
    await flush();

    capturedOptions?.onSnapshot(createNeovimRenderSnapshot(2, 10));
    capturedOptions?.onDirtyChange?.(true);
    capturedOptions?.onError(new Error("stale error"));
    capturedOptions?.onExit();
    pending.resolve(harness.session);
    await Promise.all([open, cleanup]);

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      error: null,
      filePath: null,
    });
    expect(harness.session.cleanup).toHaveBeenCalledTimes(1);
  });

  it("normalizes Neovim buffer names before using them as disk-baseline keys", () => {
    const neovimName =
      process.platform === "win32"
        ? "C:/workspace/src/../target.txt"
        : "/workspace/src/../target.txt";
    const normalized = normalizeNeovimBufferPath(
      neovimName,
      TEST_WORKSPACE_ROOT,
    );

    expect(normalized).toBe(workspacePath("target.txt"));
    expect(neovimFileSnapshotKey(neovimName)).toBe(
      neovimFileSnapshotKey(normalized),
    );
  });

  it("handles empty provider state, Neovim callbacks, and dirty refresh failures", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);

    await expect(provider.revert()).resolves.toBeUndefined();
    await expect(provider.save()).resolves.toBe(false);
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(
      provider.handleInput({
        input: "",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(false);
    expect(provider.click(1, 1)).toBe(false);
    expect(
      reloadPathAfterExternalEditor("target.txt", workspacePath("target.txt")),
    ).toBe("target.txt");
    expect(
      reloadPathAfterExternalEditor(null, workspacePath("target.txt")),
    ).toBe(workspacePath("target.txt"));
    expect(
      refreshableFileSnapshotPaths(workspacePath("target.txt"), "target.txt"),
    ).toEqual({
      absolutePath: workspacePath("target.txt"),
      filePath: "target.txt",
    });
    expect(refreshableFileSnapshotPaths(null, "target.txt")).toBeNull();
    expect(
      refreshableFileSnapshotPaths(workspacePath("target.txt"), null),
    ).toBeNull();

    await provider.open({ filePath: "target.txt" });
    expect(
      provider.handleInput({
        input: "",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(false);
    harness.session.click.mockImplementationOnce(() => {
      throw new Error("synchronous click failure");
    });
    expect(provider.click(1, 1)).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "synchronous click failure",
    });
    harness.emitGrid("visual text", "visual");
    expect(provider.getSnapshot().vimMode).toBe("VISUAL");
    harness.emitGrid("insert text", "insert");
    expect(provider.getSnapshot().vimMode).toBe("INSERT");

    harness.emitError(new Error("nvim stderr"));
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "nvim stderr",
    });
    harness.emitExit();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "closed",
      status: "idle",
      providerMessage: "Embedded Neovim exited.",
    });
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(false);

    await provider.open({ filePath: "target.txt" });
    harness.emitDirty(true);
    expect(provider.getSnapshot().dirty).toBe(true);
    harness.emitDirty(false);
    await flush();
    expect(provider.getSnapshot().dirty).toBe(false);

    harness.session.isDirty.mockRejectedValueOnce(
      new Error("dirty read failed"),
    );
    expect(
      provider.handleInput({
        input: "x",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(provider.getSnapshot().dirty).toBe(false);

    harness.session.input.mockImplementationOnce(async () => {
      harness.emitExit();
    });
    expect(
      provider.handleInput({
        input: "y",
        key: baseKey(),
        context: { rows: 8, columns: 40 },
      }),
    ).toBe(true);
    await flush();
    expect(provider.getSnapshot().providerStatus).toBe("closed");

    await provider.open({ filePath: "target.txt" });
    harness.session.save.mockRejectedValueOnce("write string failed");
    await expect(provider.save()).resolves.toBe(false);
    expect(provider.getSnapshot().error).toBe("write string failed");
    await provider.cleanup();
    harness.emitDirty(false);
    await flush();
    expect(provider.getSnapshot().providerStatus).toBe("idle");
  });
});

function createHarness(
  overrides: {
    readonly launch?: (filePath: string, line: number) => boolean;
    readonly readFileSnapshot?: (
      filePath: string,
    ) => Promise<BufferFileSnapshot>;
    readonly startSession?: (
      options: StartEmbeddedNeovimOptions,
    ) => Promise<EmbeddedNeovimSession>;
    readonly recovery?: EmbeddedNeovimRecoveryInfo | null;
  } = {},
) {
  let currentPath = workspacePath("target.txt");
  let nextHandle = 2;
  const buffers = new Map<
    string,
    {
      handle: number;
      dirty: boolean;
      changedtick: number;
      endOfLine: boolean;
    }
  >([
    [currentPath, { handle: 1, dirty: false, changedtick: 1, endOfLine: true }],
  ]);
  const currentBuffer = () => {
    const existing = buffers.get(currentPath);
    if (existing) return existing;
    const created = {
      handle: nextHandle,
      dirty: false,
      changedtick: 1,
      endOfLine: true,
    };
    nextHandle += 1;
    buffers.set(currentPath, created);
    return created;
  };
  let onSnapshot:
    ((snapshot: ReturnType<typeof createNeovimRenderSnapshot>) => void) | null =
    null;
  let onDirtyChange: ((dirty: boolean) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let onExit: ((exit: NeovimExitInfo) => void) | null = null;
  let onIntegrationIntent: ((intent: BufferIntegrationIntent) => void) | null =
    null;
  let onCodePredictionFeedback:
    ((feedback: BufferCodePredictionFeedback) => void) | null = null;
  let onRecoveryDetected:
    | ((recovery: {
        readonly swapFile: string;
        readonly filePath: string;
      }) => void)
    | null = null;
  let onBeforeWorkspaceWrite:
    | ((
        request: BufferWorkspaceWriteRequest,
      ) => Promise<BufferWorkspaceWriteDecision>)
    | null = null;
  const save = vi.fn(async () => {
    currentBuffer().dirty = false;
    return true;
  });
  const session = {
    pid: 12345,
    recovery: overrides.recovery ?? null,
    input: vi.fn(async (keys: string) => {
      if (keys.includes(":edit!")) currentBuffer().dirty = false;
      else if (keys.length > 0) {
        currentBuffer().dirty = true;
        currentBuffer().changedtick += 1;
      }
      return true;
    }),
    paste: vi.fn(async (text: string) => {
      if (text.length > 0) {
        currentBuffer().dirty = true;
        currentBuffer().changedtick += 1;
      }
    }),
    resize: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    openFile: vi.fn(async (filePath: string) => {
      currentPath = filePath;
      currentBuffer();
      return true;
    }),
    inspectBuffers: vi.fn(async () => ({
      activeBufferHandle: currentBuffer().handle,
      buffers: [...buffers.entries()].map(([name, buffer]) => ({
        handle: buffer.handle,
        changedtick: buffer.changedtick,
        endOfLine: buffer.endOfLine,
        name,
        listed: true,
        loaded: true,
        modified: buffer.dirty,
        current: name === currentPath,
        bufferType: "",
        modifiable: true,
        readOnly: false,
        saveable: true,
      })),
    })),
    inspectDirtyBuffers: vi.fn(async () =>
      [...buffers.entries()]
        .filter(([, buffer]) => buffer.dirty)
        .map(([name, buffer]) => ({
          handle: buffer.handle,
          changedtick: buffer.changedtick,
          endOfLine: buffer.endOfLine,
          name,
          listed: true,
          loaded: true,
          modified: true,
          current: name === currentPath,
          bufferType: "",
          modifiable: true,
          readOnly: false,
          saveable: true,
        })),
    ),
    save,
    saveBuffer: vi.fn(
      async (handle: number, force: boolean, expectedChangedtick?: number) => {
        const target = [...buffers.values()].find(
          (buffer) => buffer.handle === handle,
        );
        if (!target) return false;
        if (
          expectedChangedtick !== undefined &&
          target.changedtick !== expectedChangedtick
        ) {
          throw new Error(`buffer changed before write: ${handle}`);
        }
        const result = await save(force);
        if (result) target.dirty = false;
        return result;
      },
    ),
    rebaseFileBuffers: vi.fn(
      async (
        changes: readonly {
          readonly handle: number;
          readonly fromPath: string;
          readonly toPath: string;
        }[],
      ) => {
        for (const change of changes) {
          const buffer = buffers.get(change.fromPath);
          if (!buffer || buffer.handle !== change.handle || buffer.dirty) {
            throw new Error(`cannot rebase buffer ${change.handle}`);
          }
          buffers.delete(change.fromPath);
          buffers.set(change.toPath, buffer);
          if (currentPath === change.fromPath) currentPath = change.toPath;
        }
      },
    ),
    deleteFileBuffers: vi.fn(
      async (
        deletions: readonly {
          readonly handle: number;
          readonly path: string;
        }[],
      ) => {
        for (const deletion of deletions) {
          const buffer = buffers.get(deletion.path);
          if (!buffer || buffer.handle !== deletion.handle || buffer.dirty) {
            throw new Error(`cannot delete buffer ${deletion.handle}`);
          }
        }
        for (const deletion of deletions) buffers.delete(deletion.path);
        if (deletions.some((deletion) => deletion.path === currentPath)) {
          currentPath = buffers.keys().next().value ?? "";
        }
      },
    ),
    saveAll: vi.fn(async (force: boolean) => {
      const dirtyBuffers = [...buffers.entries()].filter(
        ([, buffer]) => buffer.dirty,
      );
      for (const [, buffer] of dirtyBuffers) buffer.dirty = false;
      return {
        saved: true as const,
        buffers: dirtyBuffers.map(([name, buffer]) => ({
          handle: buffer.handle,
          changedtick: buffer.changedtick,
          endOfLine: buffer.endOfLine,
          name,
          listed: true,
          loaded: true,
          modified: true,
          current: name === currentPath,
          bufferType: "",
          modifiable: true,
          readOnly: false,
          saveable: true,
        })),
      };
    }),
    discardAll: vi.fn(
      async (
        expectedBuffers: readonly {
          readonly handle: number;
          readonly name: string;
          readonly changedtick: number | null;
        }[] = [],
      ) => {
        const dirtyBuffers = [...buffers.entries()].filter(
          ([, buffer]) => buffer.dirty,
        );
        if (
          dirtyBuffers.length !== expectedBuffers.length ||
          expectedBuffers.some((expected) => {
            const actual = dirtyBuffers.find(
              ([, buffer]) => buffer.handle === expected.handle,
            );
            return (
              !actual ||
              actual[0] !== expected.name ||
              actual[1].changedtick !== expected.changedtick
            );
          })
        ) {
          return false;
        }
        for (const expected of expectedBuffers) {
          const target = [...buffers.values()].find(
            (buffer) => buffer.handle === expected.handle,
          );
          if (target) target.dirty = false;
        }
        return ![...buffers.values()].some((buffer) => buffer.dirty);
      },
    ),
    applyRecovery: vi.fn(async () => currentBuffer().handle),
    finishRecovery: vi.fn(async () => workspacePath(".first.txt.swp")),
    captureCodePredictionContext: vi.fn(async () => ({
      bufferHandle: currentBuffer().handle,
      path: currentPath,
      changedtick: currentBuffer().changedtick,
      cursor: { line: 0, byteColumn: 5 },
      prefix: "const",
      suffix: " value = true;",
      language: "typescript",
    })),
    stageCodePrediction: vi.fn(async () => true),
    clearCodePrediction: vi.fn(async () => true),
    isDirty: vi.fn(async () => currentBuffer().dirty),
    hasUnsavedBuffers: vi.fn(async () =>
      [...buffers.values()].some((buffer) => buffer.dirty),
    ),
    quit: vi.fn(async (discard = false) =>
      [...buffers.values()].some((buffer) => buffer.dirty) && !discard
        ? {
            closed: false as const,
            reason:
              "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
          }
        : { closed: true as const },
    ),
    cleanup: vi.fn(async () => {}),
  } as any as EmbeddedNeovimSession;
  const readFileSnapshot =
    overrides.readFileSnapshot ??
    vi.fn(async (filePath: string) => ({
      filePath,
      absolutePath: isAbsolute(filePath) ? filePath : workspacePath(filePath),
      content: "alpha\n",
      mtimeMs: 1,
      size: 6,
      encoding: "utf8",
      lineEndings: "LF",
    }));
  const startSession =
    overrides.startSession ??
    vi.fn(async (options: StartEmbeddedNeovimOptions) => {
      currentPath = options.filePath;
      currentBuffer();
      onSnapshot = options.onSnapshot;
      onDirtyChange = options.onDirtyChange ?? null;
      onError = options.onError;
      onExit = options.onExit;
      onIntegrationIntent = options.onIntegrationIntent ?? null;
      onCodePredictionFeedback = options.onCodePredictionFeedback ?? null;
      onRecoveryDetected = options.onRecoveryDetected ?? null;
      onBeforeWorkspaceWrite = options.onBeforeWorkspaceWrite ?? null;
      const snapshot = createNeovimRenderSnapshot(
        options.size.rows,
        options.size.columns,
      );
      onSnapshot({
        ...snapshot,
        lines: ["", "    alpha", ""],
        cursor: { row: 1, column: 4, grid: 1 },
        mode: "normal",
      });
      return session;
    });
  return {
    session: session as EmbeddedNeovimSession & {
      input: ReturnType<typeof vi.fn>;
      paste: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      click: ReturnType<typeof vi.fn>;
      openFile: ReturnType<typeof vi.fn>;
      inspectBuffers: ReturnType<typeof vi.fn>;
      inspectDirtyBuffers: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      saveBuffer: ReturnType<typeof vi.fn>;
      rebaseFileBuffers: ReturnType<typeof vi.fn>;
      deleteFileBuffers: ReturnType<typeof vi.fn>;
      saveAll: ReturnType<typeof vi.fn>;
      discardAll: ReturnType<typeof vi.fn>;
      applyRecovery: ReturnType<typeof vi.fn>;
      finishRecovery: ReturnType<typeof vi.fn>;
      captureCodePredictionContext: ReturnType<typeof vi.fn>;
      stageCodePrediction: ReturnType<typeof vi.fn>;
      clearCodePrediction: ReturnType<typeof vi.fn>;
      isDirty: ReturnType<typeof vi.fn>;
      hasUnsavedBuffers: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
      cleanup: ReturnType<typeof vi.fn>;
    },
    startSession,
    setDirty(value: boolean) {
      currentBuffer().dirty = value;
      if (value) currentBuffer().changedtick += 1;
    },
    setBufferTextReader(reader: (handle: number) => Promise<string>) {
      (
        session as unknown as {
          readBufferText?: (handle: number) => Promise<string>;
        }
      ).readBufferText = reader;
    },
    mutateBuffer(filePath = currentPath) {
      const existing = buffers.get(filePath);
      if (existing) {
        existing.dirty = true;
        existing.changedtick += 1;
        return;
      }
      buffers.set(filePath, {
        handle: nextHandle,
        dirty: true,
        changedtick: 1,
        endOfLine: true,
      });
      nextHandle += 1;
    },
    setEndOfLine(value: boolean, filePath = currentPath) {
      const buffer = buffers.get(filePath);
      if (!buffer) {
        throw new Error(`No harness buffer for ${filePath}`);
      }
      buffer.endOfLine = value;
    },
    activatePath(filePath: string) {
      currentPath = filePath;
      currentBuffer();
    },
    emitGrid(text: string, mode = "normal") {
      const snapshot = createNeovimRenderSnapshot(3, 20);
      onSnapshot?.({
        ...snapshot,
        lines: [text],
        cursor: { row: 0, column: 0, grid: 1 },
        mode,
      });
    },
    emitDirty(value: boolean) {
      currentBuffer().dirty = value;
      if (value) currentBuffer().changedtick += 1;
      onDirtyChange?.(value);
    },
    emitError(error: Error) {
      onError?.(error);
    },
    emitExit(exit = { code: 0, signal: null, stderrTail: "" }) {
      onExit?.(exit);
    },
    emitIntegrationIntent(intent: BufferIntegrationIntent) {
      onIntegrationIntent?.(intent);
    },
    emitCodePredictionFeedback(feedback: BufferCodePredictionFeedback) {
      onCodePredictionFeedback?.(feedback);
    },
    emitRecovery(recovery: {
      readonly swapFile: string;
      readonly filePath: string;
    }) {
      onRecoveryDetected?.(recovery);
    },
    requestWorkspaceWrite(
      request: BufferWorkspaceWriteRequest,
    ): Promise<BufferWorkspaceWriteDecision> {
      return (
        onBeforeWorkspaceWrite?.(request) ??
        Promise.resolve({
          allowed: false,
          reason: "workspace write callback unavailable",
        })
      );
    },
    options: {
      discovery: usableDiscovery,
      openExternalEditor: overrides.launch,
      readFileSnapshot,
      startSession,
      cleanupTimeoutMs: 10,
    },
  };
}

function snapshotFor(filePath: string, mtimeMs: number): BufferFileSnapshot {
  return {
    filePath,
    absolutePath: workspacePath(filePath),
    content: "alpha\n",
    mtimeMs,
    size: 6,
    encoding: "utf8",
    lineEndings: "LF",
  };
}

function integrationIntent(
  path: string,
  bufferHandle = 7,
): BufferIntegrationIntent {
  return {
    kind: "fix",
    context: {
      kind: "selection",
      bufferHandle,
      path,
      range: {
        start: { line: 4, column: 2 },
        end: { line: 6, column: 8 },
      },
      content: "selected source",
      dirty: true,
      selectionMode: "character",
      changedtick: 17,
    },
  };
}

function workspaceWriteRequest(
  target: Pick<
    BufferWorkspaceWriteRequest["target"],
    "path" | "sourcePath" | "kind"
  >,
): BufferWorkspaceWriteRequest {
  return {
    target: {
      ...target,
      bufferHandle: 1,
      changedtick: 1,
      endOfLine: true,
      lineStart: 1,
      lineEnd: 1,
    },
    buffers: [
      {
        path: target.sourcePath,
        bufferHandle: 1,
        changedtick: 1,
        endOfLine: true,
        dirty: true,
        content: "alpha\n",
      },
    ],
  };
}

function baseKey() {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
