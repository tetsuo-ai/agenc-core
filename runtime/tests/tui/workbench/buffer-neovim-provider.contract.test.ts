import { describe, expect, it, vi } from "vitest";

import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import { NeovimBufferProvider, refreshableFileSnapshotPaths, reloadPathAfterExternalEditor } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import type { BufferFileSnapshot } from "../../../src/tui/workbench/buffer/fileSnapshot.js";
import {
  NeovimStartupCleanupError,
  type EmbeddedNeovimSession,
  type StartEmbeddedNeovimOptions,
} from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";

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

    harness.session.isDirty.mockClear();
    expect(provider.handleInput({ input: "o", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    expect(provider.handleInput({ input: "K", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("o");
    expect(harness.session.input).toHaveBeenCalledWith("K");
    expect(harness.session.isDirty).not.toHaveBeenCalled();

    harness.session.input.mockClear();
    harness.session.paste.mockClear();
    expect(provider.handleInput({ input: "hello", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.input).toHaveBeenCalledWith("hello");
    expect(harness.session.paste).not.toHaveBeenCalled();

    harness.session.input.mockClear();
    harness.session.paste.mockClear();
    expect(provider.handleInput({ input: "hello", key: baseKey(), isPaste: true, context: { rows: 8, columns: 40 } })).toBe(true);
    await flush();
    expect(harness.session.paste).toHaveBeenCalledWith("hello");
    expect(harness.session.input).not.toHaveBeenCalled();

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

    harness.session.input.mockRejectedValueOnce(new Error("undo transport failed"));
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

  it("retains dirty Neovim edits when another file is requested and retries after save", async () => {
    const harness = createHarness();
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    harness.setDirty(true);
    harness.emitDirty(true);

    await expect(provider.open({ filePath: "next.txt" })).resolves.toBeUndefined();

    expect(harness.session.quit).toHaveBeenCalledWith(false);
    expect(harness.session.cleanup).not.toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      filePath: "target.txt",
      dirty: true,
      error: "Unsaved edits. Save, revert, or close-discard before opening another file.",
    });

    await expect(provider.save({ force: true })).resolves.toBe(true);
    await expect(provider.open({ filePath: "next.txt" })).resolves.toBeUndefined();

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
      dirty: false,
    });
  });

  it("does not let an older open erase a newer dirty replacement conflict", async () => {
    const initialDirtyRead = controlled<boolean>();
    const harness = createHarness();
    harness.session.isDirty.mockImplementationOnce(() => initialDirtyRead.promise);
    const provider = new NeovimBufferProvider(harness.options);

    const openingInitialFile = provider.open({ filePath: "target.txt" });
    await flush();
    expect(harness.session.isDirty).toHaveBeenCalledTimes(1);

    harness.session.quit.mockResolvedValueOnce({ closed: false, reason: "dirty buffer" });
    await expect(provider.open({ filePath: "next.txt" })).resolves.toBeUndefined();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      filePath: "target.txt",
      dirty: true,
    });

    initialDirtyRead.resolve(false);
    await openingInitialFile;

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      providerMessage: "Unsaved edits. Save, revert, or close-discard before opening another file.",
      filePath: "target.txt",
      dirty: true,
    });

    harness.emitGrid("session remains live");
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      terminal: { lines: ["session remains live"] },
      dirty: true,
    });
  });

  it("contains session cleanup failures and retains actionable BUFFER diagnostics", async () => {
    const reopenHarness = createHarness();
    const reopenProvider = new NeovimBufferProvider(reopenHarness.options);
    await reopenProvider.open({ filePath: "target.txt" });
    reopenHarness.session.quit.mockRejectedValueOnce(new Error("process tree survived"));

    await expect(reopenProvider.open({ filePath: "next.txt" })).resolves.toBeUndefined();

    expect(reopenHarness.startSession).toHaveBeenCalledTimes(1);
    expect(reopenProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error: "Embedded Neovim cleanup failed before opening another file: process tree survived",
    });
    await expect(reopenProvider.open({ filePath: "next.txt" })).resolves.toBeUndefined();
    expect(reopenHarness.startSession).toHaveBeenCalledTimes(2);
    expect(reopenProvider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      filePath: "next.txt",
    });

    const closeHarness = createHarness();
    const closeProvider = new NeovimBufferProvider(closeHarness.options);
    await closeProvider.open({ filePath: "target.txt" });
    closeHarness.session.quit.mockRejectedValueOnce(new Error("process tree survived"));

    await expect(closeProvider.close({ discard: true })).resolves.toBe(false);

    expect(closeProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error: "Embedded Neovim cleanup failed while closing BUFFER: process tree survived",
    });
    await expect(closeProvider.close({ discard: true })).resolves.toBe(true);
    expect(closeProvider.getSnapshot().providerStatus).toBe("idle");

    const cleanupHarness = createHarness();
    const cleanupProvider = new NeovimBufferProvider(cleanupHarness.options);
    await cleanupProvider.open({ filePath: "target.txt" });
    cleanupHarness.session.cleanup.mockRejectedValueOnce(new Error("process tree survived"));

    await expect(cleanupProvider.cleanup()).rejects.toThrow(
      "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    );
    expect(cleanupProvider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      filePath: "target.txt",
      error: "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
    });
    await expect(cleanupProvider.cleanup()).resolves.toBeUndefined();
    expect(cleanupProvider.getSnapshot().providerStatus).toBe("idle");
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
    harness.session.hasUnsavedBuffers.mockImplementation(() => dirtyProbe.promise);
    expect(provider.handleInput({ input: "i", key: baseKey(), context: { rows: 8, columns: 40 } })).toBe(true);
    const immediateHandoff = provider.openExternalEditor();
    expect(launch).not.toHaveBeenCalled();
    dirtyProbe.resolve(true);
    await expect(immediateHandoff).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(provider.getSnapshot().providerStatus).toBe("conflict");

    harness.session.hasUnsavedBuffers.mockRejectedValueOnce(new Error("dirty probe unavailable"));
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
      if (path === "target.txt" || path === "/workspace/target.txt") {
        return snapshotFor("target.txt", 1);
      }
      if (path === "next.txt") return pendingRead.promise;
      if (path === "/workspace/next.txt") return snapshotFor("next.txt", 2);
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ launch, readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });

    const openingNext = provider.open({ filePath: "next.txt" });
    await flush();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "loading",
      filePath: null,
      absolutePath: null,
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

  it("does not hand off the previous file while a newer open is closing it", async () => {
    const launch = vi.fn(() => true);
    const harness = createHarness({ launch });
    const provider = new NeovimBufferProvider(harness.options);
    await provider.open({ filePath: "target.txt" });
    const closeResult = controlled<{ readonly closed: true }>();
    harness.session.quit.mockImplementationOnce(() => closeResult.promise);

    const openingNext = provider.open({ filePath: "next.txt" });
    await flush();
    expect(harness.session.quit).toHaveBeenCalledWith(false);

    await expect(provider.openExternalEditor()).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
    closeResult.resolve({ closed: true });
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
    harness.session.isDirty.mockImplementationOnce(async () => {
      harness.emitExit();
      return false;
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
    const bSnapshot = { ...snapshotFor("b.txt", 2), lineEndings: "CRLF" as const };
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "a.txt") return aSnapshot;
      if (path === "/workspace/a.txt") return staleRefresh.promise;
      if (path === "b.txt" || path === "/workspace/b.txt") return bSnapshot;
      throw new Error(`unexpected read ${path}`);
    });
    const harness = createHarness({ readFileSnapshot });
    const provider = new NeovimBufferProvider(harness.options);

    const staleOpen = provider.open({ filePath: "a.txt" });
    await flush();
    expect(readFileSnapshot).toHaveBeenCalledWith("/workspace/a.txt");
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
    expect(saveReads).not.toContain("/workspace/a.txt");
    expect(saveReads).toContain("/workspace/b.txt");
  });

  it("does not redirect a stale save into the newly opened session", async () => {
    const conflictRead = controlled<BufferFileSnapshot>();
    const aSnapshot = snapshotFor("a.txt", 1);
    const bSnapshot = snapshotFor("b.txt", 2);
    let aAbsoluteReads = 0;
    const readFileSnapshot = vi.fn(async (path: string) => {
      if (path === "a.txt") return aSnapshot;
      if (path === "/workspace/a.txt") {
        aAbsoluteReads += 1;
        return aAbsoluteReads === 1 ? aSnapshot : conflictRead.promise;
      }
      if (path === "b.txt" || path === "/workspace/b.txt") return bSnapshot;
      throw new Error(`unexpected read ${path}`);
    });
    const base = createHarness({ readFileSnapshot });
    const firstSession = {
      ...base.session,
      save: vi.fn(async () => true),
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;
    const secondSession = {
      ...base.session,
      save: vi.fn(async () => true),
      cleanup: vi.fn(async () => {}),
      isDirty: vi.fn(async () => false),
    } as any as EmbeddedNeovimSession;
    const startSession = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const provider = new NeovimBufferProvider({ ...base.options, startSession });

    await provider.open({ filePath: "a.txt" });
    const staleSave = provider.save();
    await flush();
    await provider.open({ filePath: "b.txt" });
    conflictRead.resolve(aSnapshot);

    await expect(staleSave).resolves.toBe(false);
    expect((firstSession.save as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((secondSession.save as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
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

    const startupSignal = (capturedOptions as (StartEmbeddedNeovimOptions & {
      readonly signal?: AbortSignal;
    }) | null)?.signal;
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
    const rejectingProvider = new NeovimBufferProvider(rejectingHarness.options);
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
      cleanup: vi.fn()
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
      error: "Embedded Neovim cleanup failed while releasing BUFFER: process tree survived",
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
    const retryCleanup = vi.fn()
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
    hasUnsavedBuffers: vi.fn(async () => dirty),
    quit: vi.fn(async (discard = false) => dirty && !discard
      ? {
          closed: false as const,
          reason: "Unsaved Neovim edits. Save or use force quit before closing BUFFER.",
        }
      : { closed: true as const }),
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
      hasUnsavedBuffers: ReturnType<typeof vi.fn>;
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
