import { describe, expect, it, vi } from "vitest";

import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { NeovimBufferProvider, refreshableFileSnapshotPaths, reloadPathAfterExternalEditor } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import type { BufferFileSnapshot } from "../../../src/tui/workbench/buffer/fileSnapshot.js";
import type { EmbeddedNeovimSession, StartEmbeddedNeovimOptions } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
  args: ["--embed", "--clean", "-n"],
  useUserInit: false,
} as const;

describe("embedded Neovim BUFFER provider", () => {
  it("opens through the injected embedded session and publishes bounded terminal snapshots", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    await provider.open({ filePath: "target.txt", line: 3, column: 2 });

    expect(harness.startSession).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/usr/bin/nvim",
      args: ["--embed", "--clean", "-n"],
      filePath: "/workspace/target.txt",
      line: 3,
      column: 2,
      size: { rows: 20, columns: 80 },
    }));
    expect(provider.getSnapshot()).toMatchObject({
      status: "ready",
      providerStatus: "ready",
      filePath: "target.txt",
      absolutePath: "/workspace/target.txt",
      dirty: false,
      provider: { kind: "neovim" },
      position: { line: 2, column: 4 },
    });
    expect(provider.getSnapshot().terminal?.lines[1]).toContain("alpha");
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

    expect(harness.startSession).toHaveBeenCalledWith(expect.objectContaining({
      size: { rows: 9, columns: 44 },
    }));
  });

  it("routes printable input, paste, resize, focus, undo, redo, and inert inline movements to Neovim", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    expect(provider.handleInput({ input: "i", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenLastCalledWith("i");

    expect(provider.handleInput({ input: "hello", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("<PasteStart>");
    expect(harness.session.paste).toHaveBeenCalledWith("hello");
    expect(harness.session.input).toHaveBeenCalledWith("<PasteEnd>");

    expect(provider.handleInput({ input: "", key: { ...baseKey(), escape: true }, context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("<Esc>");

    provider.resize({ rows: 1.9, columns: 2.8 });
    provider.focus(true);
    expect(provider.click(2, 5)).toBe(true);
    await flush();
    expect(harness.session.resize).toHaveBeenCalledWith({ rows: 1, columns: 2 });
    expect(harness.session.focus).toHaveBeenCalledWith(true);
    expect(harness.session.click).toHaveBeenCalledWith(2, 5);

    harness.session.click.mockRejectedValueOnce(new Error("click failed"));
    expect(provider.click(3, 6)).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "click failed" });

    harness.session.click.mockRejectedValueOnce("click string failed");
    expect(provider.click(4, 7)).toBe(true);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "click string failed" });

    harness.session.resize.mockRejectedValueOnce(new Error("resize failed"));
    provider.resize({ rows: 3, columns: 4 });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "resize failed" });

    harness.session.resize.mockRejectedValueOnce("resize string failed");
    provider.resize({ rows: 5, columns: 6 });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "resize string failed" });

    harness.session.focus.mockRejectedValueOnce(new Error("focus failed"));
    provider.focus(false);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "focus failed" });

    harness.session.focus.mockRejectedValueOnce("focus string failed");
    provider.focus(false);
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "focus string failed" });

    expect(provider.undo()).toBe(true);
    expect(provider.redo()).toBe(true);
    await provider.revert();
    expect(harness.session.input).toHaveBeenCalledWith("u");
    expect(harness.session.input).toHaveBeenCalledWith("<C-r>");
    expect(harness.session.input).toHaveBeenCalledWith("<Esc>:edit!<CR>");
    expect(provider.move("down")).toBe(false);
    await expect(provider.requestHover()).resolves.toBeNull();
    await expect(provider.goToDefinition()).resolves.toBe(false);
  });

  it("refuses in-flight agent saves, surfaces session save failures, and recovers after a clean save", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    await expect(provider.save({ hasInFlightAgent: true })).resolves.toBe(false);
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

    harness.setDirty(false);
    await expect(provider.save({ force: true })).resolves.toBe(true);
    expect(harness.session.save).toHaveBeenLastCalledWith(true);
    expect(provider.getSnapshot()).toMatchObject({
      status: "ready",
      dirty: false,
      error: null,
    });
  });

  it("reports disk read conflicts and tolerates refresh failures after a force save", async () => {
    const openedSnapshot = snapshotFor("target.txt", 1);
    const conflictRead = vi.fn()
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

    const refreshRead = vi.fn()
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

    harness.session.quit.mockResolvedValueOnce({ closed: false, reason: "dirty buffer" });
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

  it("guards external editor handoff behind a clean embedded buffer and reloads after a successful handoff", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    const dirtyProbe = controlled<boolean>();
    harness.session.isDirty.mockImplementation(() => dirtyProbe.promise);
    expect(provider.handleInput({ input: "i", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    const immediateHandoff = provider.openExternalEditor();
    expect(launch).not.toHaveBeenCalled();
    dirtyProbe.resolve(true);
    await expect(immediateHandoff).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(provider.getSnapshot().providerStatus).toBe("conflict");

    harness.session.isDirty.mockImplementation(async () => false);
    harness.setDirty(false);
    await expect(provider.save()).resolves.toBe(true);
    await expect(provider.openExternalEditor()).resolves.toBe(true);
    expect(launch).toHaveBeenCalledWith("/workspace/target.txt", 2);
    expect(harness.startSession).toHaveBeenCalledTimes(2);

    launch.mockReturnValueOnce(false);
    const startCountBeforeCancel = harness.startSession.mock.calls.length;
    const cleanupCountBeforeCancel = harness.session.cleanup.mock.calls.length;
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("No external editor"),
    });
    expect(harness.startSession).toHaveBeenCalledTimes(startCountBeforeCancel);
    expect(harness.session.cleanup).toHaveBeenCalledTimes(cleanupCountBeforeCancel);
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

    expect(launch).toHaveBeenCalledWith("/workspace/target.txt", 2);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
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
    const stringFailingProvider = new NeovimBufferProvider(stringFailing.options);
    await stringFailingProvider.open({ filePath: "missing.txt" });
    expect(stringFailingProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "read string failed",
    });

    const startupFailure = createHarness();
    startupFailure.startSession.mockRejectedValueOnce(new Error("startup exited"));
    const recoveringProvider = new NeovimBufferProvider(startupFailure.options);
    await recoveringProvider.open({ filePath: "target.txt" });
    expect(recoveringProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: "startup exited",
    });
    await recoveringProvider.open({ filePath: "target.txt" });
    expect(recoveringProvider.getSnapshot().providerStatus).toBe("ready");
  });

  it("cleans up a stale session that resolves after a newer open supersedes it", async () => {
    const first = controlled<EmbeddedNeovimSession>();
    const second = controlled<EmbeddedNeovimSession>();
    const harness = createHarness({
      startSession: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const provider = new NeovimBufferProvider(harness.options);
    const staleSession = {
      ...harness.session,
      cleanup: vi.fn(async () => {
        throw new Error("stale cleanup failed");
      }),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;
    const activeSession = {
      ...harness.session,
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;

    const staleOpen = provider.open({ filePath: "stale.txt" });
    await flush();
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    const activeOpen = provider.open({ filePath: "active.txt" });
    await flush();
    expect(harness.startSession).toHaveBeenCalledTimes(2);

    first.resolve(staleSession);
    second.resolve(activeSession);
    await Promise.all([staleOpen, activeOpen]);

    expect(staleSession.cleanup).toHaveBeenCalledTimes(1);
    expect(activeSession.cleanup).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      filePath: "active.txt",
      providerStatus: "ready",
    });
  });

  it("cancels and cleans up an in-flight session start when provider cleanup runs", async () => {
    const pending = controlled<EmbeddedNeovimSession>();
    const harness = createHarness({
      startSession: vi.fn(() => pending.promise),
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

    await provider.cleanup();
    pending.resolve(lateSession);
    await open;

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
    const rejectingProvider = new NeovimBufferProvider(rejectingHarness.options);
    const rejectingOpen = rejectingProvider.open({ filePath: "target.txt" });
    await flush();
    await rejectingProvider.cleanup();
    rejecting.reject(new Error("late startup failure"));
    await rejectingOpen;

    expect(rejectingProvider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      filePath: null,
      error: null,
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
    await provider.cleanup();

    capturedOptions?.onSnapshot(createNeovimRenderSnapshot(2, 10));
    capturedOptions?.onDirtyChange?.(true);
    capturedOptions?.onError(new Error("stale error"));
    capturedOptions?.onExit();
    pending.resolve(harness.session);
    await open;

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "idle",
      error: null,
      filePath: null,
    });
    expect(harness.session.cleanup).toHaveBeenCalledTimes(1);
  });

  it("handles empty provider state, Neovim callbacks, and dirty refresh failures", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);

    await expect(provider.revert()).resolves.toBeUndefined();
    await expect(provider.save()).resolves.toBe(false);
    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(provider.handleInput({ input: "", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(false);
    expect(provider.click(1, 1)).toBe(false);
    expect(reloadPathAfterExternalEditor("target.txt", "/workspace/target.txt")).toBe("target.txt");
    expect(reloadPathAfterExternalEditor(null, "/workspace/target.txt")).toBe("/workspace/target.txt");
    expect(refreshableFileSnapshotPaths("/workspace/target.txt", "target.txt")).toEqual({
      absolutePath: "/workspace/target.txt",
      filePath: "target.txt",
    });
    expect(refreshableFileSnapshotPaths(null, "target.txt")).toBeNull();
    expect(refreshableFileSnapshotPaths("/workspace/target.txt", null)).toBeNull();

    await provider.open({ filePath: "target.txt" });
    expect(provider.handleInput({ input: "", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(false);
    harness.emitGrid("visual text", "visual");
    expect(provider.getSnapshot().vimMode).toBe("VISUAL");
    harness.emitGrid("insert text", "insert");
    expect(provider.getSnapshot().vimMode).toBe("INSERT");

    harness.emitError(new Error("nvim stderr"));
    expect(provider.getSnapshot()).toMatchObject({ providerStatus: "error", error: "nvim stderr" });
    harness.emitExit();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "closed",
      status: "idle",
      providerMessage: "Embedded Neovim exited.",
    });
    expect(provider.handleInput({ input: "x", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(false);

    await provider.open({ filePath: "target.txt" });
    harness.emitDirty(true);
    expect(provider.getSnapshot().dirty).toBe(true);
    harness.emitDirty(false);
    await flush();
    expect(provider.getSnapshot().dirty).toBe(false);

    harness.session.isDirty.mockRejectedValueOnce(new Error("dirty read failed"));
    expect(provider.handleInput({ input: "x", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(provider.getSnapshot().dirty).toBe(false);

    harness.session.input.mockImplementationOnce(async () => {
      harness.emitExit();
    });
    expect(provider.handleInput({ input: "y", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
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

function createHarness(overrides: {
  readonly launch?: (filePath: string, line: number) => boolean;
  readonly readFileSnapshot?: (filePath: string) => Promise<BufferFileSnapshot>;
  readonly startSession?: (options: StartEmbeddedNeovimOptions) => Promise<EmbeddedNeovimSession>;
} = {}) {
  let dirty = false;
  let onSnapshot: ((snapshot: ReturnType<typeof createNeovimRenderSnapshot>) => void) | null = null;
  let onDirtyChange: ((dirty: boolean) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let onExit: (() => void) | null = null;
  const session = {
    pid: 12345,
    input: vi.fn(async (keys: string) => {
      if (keys.length > 0) dirty = true;
    }),
    paste: vi.fn(async (text: string) => {
      if (text.length > 0) dirty = true;
    }),
    resize: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    save: vi.fn(async () => {
      dirty = false;
      return true;
    }),
    isDirty: vi.fn(async () => dirty),
    quit: vi.fn(async () => ({ closed: true as const })),
    cleanup: vi.fn(async () => {}),
  } as any as EmbeddedNeovimSession;
  const readFileSnapshot = overrides.readFileSnapshot ?? vi.fn(async (filePath: string) => ({
    filePath,
    absolutePath: `/workspace/${filePath}`,
    content: "alpha\n",
    mtimeMs: 1,
    size: 6,
    encoding: "utf8",
    lineEndings: "LF",
  }));
  const startSession = overrides.startSession ?? vi.fn(async (options: StartEmbeddedNeovimOptions) => {
    onSnapshot = options.onSnapshot;
    onDirtyChange = options.onDirtyChange ?? null;
    onError = options.onError;
    onExit = options.onExit;
    const snapshot = createNeovimRenderSnapshot(options.size.rows, options.size.columns);
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
      save: ReturnType<typeof vi.fn>;
      isDirty: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
      cleanup: ReturnType<typeof vi.fn>;
    },
    startSession,
    setDirty(value: boolean) {
      dirty = value;
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
      dirty = value;
      onDirtyChange?.(value);
    },
    emitError(error: Error) {
      onError?.(error);
    },
    emitExit() {
      onExit?.();
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
    absolutePath: `/workspace/${filePath}`,
    content: "alpha\n",
    mtimeMs,
    size: 6,
    encoding: "utf8",
    lineEndings: "LF",
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
