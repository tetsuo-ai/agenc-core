import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lspHarness = vi.hoisted(() => ({
  notifyBufferLspChanged: vi.fn(),
  notifyBufferLspClosed: vi.fn(),
  notifyBufferLspOpened: vi.fn(),
  notifyBufferLspSaved: vi.fn(),
  requestBufferDefinition: vi.fn(),
  requestBufferHover: vi.fn(),
}));

const logHarness = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../../../src/tui/workbench/buffer/lsp.js", () => lspHarness);
vi.mock("../../../src/utils/log.js", () => logHarness);

import { runWithCwdOverride } from "../../../src/utils/cwd.js";
import type { Key } from "../../../src/tui/ink.js";
import {
  getWorkbenchBufferStore,
  resetWorkbenchBufferStoreForTesting,
  type BufferVimCommand,
  WorkbenchBufferStore,
} from "../../../src/tui/workbench/buffer/BufferStore.js";
import {
  BufferBinaryFileError,
  BufferFileTooLargeError,
  readBufferFileSnapshot,
} from "../../../src/tui/workbench/buffer/fileSnapshot.js";

let dir: string;

function key(overrides: Partial<Key> = {}): Key {
  return {
    ctrl: false,
    shift: false,
    fn: false,
    meta: false,
    super: false,
    escape: false,
    return: false,
    tab: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    ...overrides,
  } as Key;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-"));
  for (const fn of Object.values(lspHarness)) fn.mockReset();
  logHarness.logError.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkbenchBufferStore", () => {
  it("opens, edits, saves, and preserves CRLF line endings", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\r\nomega\r\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("A");
    expect(store.getSnapshot().dirty).toBe(true);

    await expect(store.save()).resolves.toBe(true);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(await readFile(file, "utf8")).toBe("Aalpha\r\nomega\r\n");
  });

  it("uses the singleton buffer store until reset for tests", () => {
    resetWorkbenchBufferStoreForTesting();
    const first = getWorkbenchBufferStore();
    expect(getWorkbenchBufferStore()).toBe(first);

    resetWorkbenchBufferStoreForTesting();
    expect(getWorkbenchBufferStore()).not.toBe(first);
  });

  it("preserves UTF-16LE files on save", async () => {
    const file = join(dir, "utf16.txt");
    await writeFile(file, Buffer.from("\ufeffalpha\r\n", "utf16le"));
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("utf16.txt"));
    store.insert("A");
    await expect(store.save()).resolves.toBe(true);

    const saved = await readFile(file);
    expect(saved.toString("utf16le")).toBe("\ufeffAalpha\r\n");
  });

  it("treats clean saves as no-ops", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.save()).resolves.toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\n");
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it("reports disk save conflicts without clearing the dirty buffer", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    await writeFile(file, Buffer.from([0x61, 0x00, 0x62]));
    store.insert("draft ");

    await expect(store.save()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
      dirty: true,
      error: "target.txt changed on disk after the buffer was opened. Revert or reopen before saving.",
    });
    expect(store.getText()).toBe("draft alpha\n");
  });

  it("logs failed save notifications without failing the save", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const error = new Error("save notification failed");
    lspHarness.notifyBufferLspSaved.mockImplementation(() => {
      throw error;
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    await expect(store.save()).resolves.toBe(true);
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      filePath: "target.txt",
      dirty: false,
      error: null,
    });
    expect(await readFile(file, "utf8")).toBe("draft alpha\n");
  });

  it("reverts explicit unsaved edits from disk", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");
    expect(store.getText()).toBe("draft alpha\n");

    await store.revert();
    expect(store.getText()).toBe("alpha\n");
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it("ignores stale file loads after the buffer is closed", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    const open = runWithCwdOverride(dir, () => store.open("target.txt"));
    expect(store.getSnapshot().status).toBe("loading");

    expect(store.close()).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      filePath: null,
    });

    await open;

    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      filePath: null,
    });
    expect(store.getText()).toBe("");
  });

  it("logs failed close notifications without blocking buffer close", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const error = new Error("close notification failed");
    lspHarness.notifyBufferLspClosed.mockImplementation(() => {
      throw error;
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.close()).toBe(true);
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      filePath: null,
      error: null,
    });
    expect(store.getText()).toBe("");
  });

  it("handles empty-buffer public operations as no-ops", async () => {
    const store = new WorkbenchBufferStore();

    expect(store.getText()).toBe("");
    expect(store.getVisibleLines()).toEqual([]);
    await expect(store.revert()).resolves.toBeUndefined();
    await expect(store.save()).resolves.toBe(false);
    await expect(store.openExternalEditor()).resolves.toBe(false);
    await expect(store.requestHover()).resolves.toBeNull();
    await expect(store.goToDefinition()).resolves.toBe(false);
    expect(store.handleVimInput("i", key(), 80)).toBe(false);
    expect(() => {
      store.insert("ignored");
      store.newline();
      store.backspace();
      store.deleteForward();
      store.move("down");
      store.undo();
      store.redo();
    }).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      dirty: false,
      lineCount: 0,
      position: { line: 1, column: 0, offset: 0 },
      selection: { anchor: 0, head: 0 },
    });
  });

  it("notifies subscribers and reports visible viewport lines", async () => {
    await writeFile(join(dir, "target.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    const store = new WorkbenchBufferStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    expect(calls).toBeGreaterThan(0);

    const beforeNoop = calls;
    store.setViewportRows(20);
    expect(calls).toBe(beforeNoop);

    store.setViewportRows(1.8);
    expect(store.getSnapshot().viewportRows).toBe(1);
    expect(store.getVisibleLines().map(line => [line.number, line.text])).toEqual([[1, "one"]]);

    store.move("down");
    store.move("down");
    expect(store.getSnapshot()).toMatchObject({
      position: { line: 3 },
      scrollLine: 2,
    });
    expect(store.getVisibleLines().map(line => [line.number, line.text])).toEqual([[3, "three"]]);

    store.move("up");
    expect(store.getSnapshot()).toMatchObject({
      position: { line: 2 },
      scrollLine: 1,
    });

    unsubscribe();
    const afterUnsubscribe = calls;
    store.move("down");
    expect(calls).toBe(afterUnsubscribe);
  });

  it("refuses to close dirty buffers unless discard is explicit", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    expect(store.close()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
      dirty: true,
      filePath: "target.txt",
      error: "Unsaved edits. Save, revert, or close-discard before closing.",
    });

    expect(store.close({ discard: true })).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      filePath: null,
      dirty: false,
    });
  });

  it("opens the current file in the external editor and reloads after it exits", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const calls: Array<{ readonly path: string; readonly line?: number }> = [];
    const store = new WorkbenchBufferStore({
      openExternalEditor: (path, line) => {
        calls.push({ path, line });
        writeFileSync(path, "edited\n", "utf8");
        return true;
      },
    });

    await runWithCwdOverride(dir, () => store.open("target.txt", 2));
    await expect(store.openExternalEditor()).resolves.toBe(true);

    expect(calls).toEqual([{ path: file, line: 2 }]);
    expect(store.getText()).toBe("edited\n");
    expect(store.getSnapshot()).toMatchObject({
      dirty: false,
      filePath: "target.txt",
      position: { line: 2 },
    });
  });

  it("logs external editor launcher exceptions without rejecting", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const error = new Error("editor crashed");
    const store = new WorkbenchBufferStore({
      openExternalEditor: () => {
        throw error;
      },
    });

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.openExternalEditor()).resolves.toBe(false);
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      filePath: "target.txt",
      error: "Failed to open external editor: editor crashed",
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("formats non-Error external editor exceptions", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore({
      openExternalEditor: () => {
        throw "editor string failure";
      },
    });

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.openExternalEditor()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "Failed to open external editor: editor string failure",
    });
  });

  it("reports unavailable external editors without changing the buffer", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore({
      openExternalEditor: () => false,
    });

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.openExternalEditor()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      filePath: "target.txt",
      dirty: false,
      error: "No external editor is available for BUFFER. Set $VISUAL or $EDITOR, or install nvim/vim.",
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("logs failed open notifications without blocking the loaded buffer", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const error = new Error("open notification failed");
    lspHarness.notifyBufferLspOpened.mockImplementation(() => {
      throw error;
    });
    const store = new WorkbenchBufferStore();

    await expect(runWithCwdOverride(dir, () => store.open("target.txt"))).resolves.toBeUndefined();

    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      filePath: "target.txt",
      error: null,
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("ignores stale hover responses after switching files", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(dir, "next.txt"), "omega\n", "utf8");
    let resolveHover: ((value: string | null) => void) | undefined;
    lspHarness.requestBufferHover.mockImplementation(() => new Promise<string | null>((resolve) => {
      resolveHover = resolve;
    }));
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    const hover = store.requestHover();
    await runWithCwdOverride(dir, () => store.open("next.txt"));
    resolveHover?.("stale hover");

    await expect(hover).resolves.toBeNull();
    expect(store.getSnapshot()).toMatchObject({
      filePath: "next.txt",
      hoverText: null,
    });
  });

  it("logs rejected hover requests while preserving the current buffer", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const error = new Error("hover request failed");
    lspHarness.requestBufferHover.mockRejectedValue(error);
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.requestHover()).resolves.toBeNull();
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      filePath: "target.txt",
      hoverText: null,
      status: "ready",
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("logs failed change notifications without rejecting edits", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const error = new Error("change notification failed");
    lspHarness.notifyBufferLspChanged.mockImplementation(() => {
      throw error;
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(() => store.insert("draft ")).not.toThrow();
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      filePath: "target.txt",
      dirty: true,
      error: null,
    });
    expect(store.getText()).toBe("draft alpha\n");
  });

  it("ignores stale definition responses after switching files", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(dir, "next.txt"), "omega\n", "utf8");
    await writeFile(join(dir, "definition.txt"), "definition\n", "utf8");
    let resolveDefinition:
      | ((value: { readonly path: string; readonly line: number; readonly character: number } | null) => void)
      | undefined;
    lspHarness.requestBufferDefinition.mockImplementation(() => new Promise((resolve) => {
      resolveDefinition = resolve;
    }));
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    const definition = store.goToDefinition();
    await runWithCwdOverride(dir, () => store.open("next.txt"));
    resolveDefinition?.({ path: join(dir, "definition.txt"), line: 1, character: 0 });

    await expect(definition).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      filePath: "next.txt",
      position: { line: 1 },
    });
    expect(store.getText()).toBe("omega\n");
  });

  it("logs rejected definition requests without changing the buffer", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    const error = new Error("definition request failed");
    lspHarness.requestBufferDefinition.mockRejectedValue(error);
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.goToDefinition()).resolves.toBe(false);
    expect(logHarness.logError).toHaveBeenCalledWith(error);
    expect(store.getSnapshot()).toMatchObject({
      filePath: "target.txt",
      position: { line: 1 },
      status: "ready",
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("reports failed definition navigation when unsaved edits block cross-file loads", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(dir, "definition.txt"), "definition\n", "utf8");
    lspHarness.requestBufferDefinition.mockResolvedValue({
      path: join(dir, "definition.txt"),
      line: 1,
      character: 0,
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    await expect(store.goToDefinition()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
      filePath: "target.txt",
      dirty: true,
    });
    expect(store.getText()).toBe("draft alpha\n");
  });

  it("blocks direct file opens when inline edits are dirty", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(dir, "next.txt"), "omega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    await expect(runWithCwdOverride(dir, () => store.open("next.txt"))).resolves.toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
      filePath: "target.txt",
      dirty: true,
      error: "Unsaved edits. Save, revert, or close-discard before opening another file.",
    });
    expect(store.getText()).toBe("draft alpha\n");
  });

  it("keeps definition targets with leading-dot relative names relative", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    await writeFile(join(dir, "..definition.txt"), "definition\n", "utf8");
    lspHarness.requestBufferDefinition.mockResolvedValue({
      path: join(dir, "..definition.txt"),
      line: 1,
      character: 0,
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(runWithCwdOverride(dir, () => store.goToDefinition())).resolves.toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      filePath: "..definition.txt",
      position: { line: 1 },
    });
    expect(store.getText()).toBe("definition\n");
  });

  it("reports failed definition navigation when the target cannot be loaded", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\n", "utf8");
    lspHarness.requestBufferDefinition.mockResolvedValue({
      path: join(dir, "missing.txt"),
      line: 1,
      character: 0,
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    await expect(store.goToDefinition()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      filePath: "target.txt",
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("ignores stale LSP responses after moving within the same file", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\nomega\n", "utf8");
    await writeFile(join(dir, "definition.txt"), "definition\n", "utf8");
    let resolveHover: ((value: string | null) => void) | undefined;
    let resolveDefinition:
      | ((value: { readonly path: string; readonly line: number; readonly character: number } | null) => void)
      | undefined;
    lspHarness.requestBufferHover.mockImplementation(() => new Promise<string | null>((resolve) => {
      resolveHover = resolve;
    }));
    lspHarness.requestBufferDefinition.mockImplementation(() => new Promise((resolve) => {
      resolveDefinition = resolve;
    }));
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    const hover = store.requestHover();
    store.move("down");
    resolveHover?.("stale hover");

    await expect(hover).resolves.toBeNull();
    expect(store.getSnapshot()).toMatchObject({
      filePath: "target.txt",
      position: { line: 2 },
      hoverText: null,
    });

    const definition = store.goToDefinition();
    store.move("up");
    resolveDefinition?.({ path: join(dir, "definition.txt"), line: 1, character: 0 });

    await expect(definition).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      filePath: "target.txt",
      position: { line: 1 },
    });
    expect(store.getText()).toBe("alpha\nomega\n");
  });

  it("clears transient buffer state when reopening the current file at another line", async () => {
    await writeFile(join(dir, "target.txt"), "alpha\nomega\n", "utf8");
    lspHarness.requestBufferHover.mockResolvedValue("alpha hover");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    await expect(store.requestHover()).resolves.toBe("alpha hover");

    store.handleVimInput(":", key({ shift: true }), 80);
    for (const char of "nope") {
      store.handleVimInput(char, key(), 80);
    }
    store.handleVimInput("", key({ return: true }), 80);
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      hoverText: "alpha hover",
    });

    await runWithCwdOverride(dir, () => store.open("target.txt", 2));

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      filePath: "target.txt",
      position: { line: 2 },
      error: null,
      conflictKind: null,
      hoverText: null,
    });
    expect(store.getText()).toBe("alpha\nomega\n");
  });

  it("requires inline edits to be saved or reverted before opening the external editor", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const calls: string[] = [];
    const store = new WorkbenchBufferStore({
      openExternalEditor: (path) => {
        calls.push(path);
        return true;
      },
    });

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    await expect(store.openExternalEditor()).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
      error: "Save or revert inline edits before opening the external editor.",
    });
  });

  it("uses the shared vim engine for normal and insert mode buffer edits", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    expect(store.handleVimInput("q", key(), 80)).toBe(true);
    expect(store.getText()).toBe("alpha\nomega\n");

    store.handleVimInput("i", key(), 80);
    store.handleVimInput("X", key({ shift: true }), 80);
    store.handleVimInput("", key({ escape: true, meta: true }), 80);

    expect(store.getText()).toBe("Xalpha\nomega\n");
    expect(store.getSnapshot().vimMode).toBe("NORMAL");

    store.handleVimInput("d", key(), 80);
    store.handleVimInput("d", key(), 80);

    expect(store.getText()).toBe("omega\n");
  });

  it("publishes insert mode immediately when vim commands enter insert", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.handleVimInput("i", key(), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("INSERT");
    expect(store.getSnapshot().selection).toEqual({ anchor: 0, head: 0 });

    expect(store.handleVimInput("", key({ escape: true }), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");

    expect(store.handleVimInput("o", key(), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("INSERT");
    expect(store.getText()).toBe("alpha\n\nomega\n");
  });

  it("lets modified and empty normal-mode inputs fall through", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.handleVimInput("x", key({ ctrl: true }), 80)).toBe(false);
    expect(store.handleVimInput("x", key({ super: true }), 80)).toBe(false);
    expect(store.handleVimInput("x", key({ meta: true }), 80)).toBe(false);
    expect(store.handleVimInput("", key(), 80)).toBe(false);
    expect(store.handleVimInput("", key({ tab: true }), 80)).toBe(true);
    expect(store.getText()).toBe("alpha\n");
    expect(store.getSnapshot().selection).toEqual({ anchor: 0, head: 0 });
  });

  it("maps normal-mode navigation keys through the vim motion layer", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.handleVimInput(".", key(), 80)).toBe(true);
    expect(store.getText()).toBe("alpha\nomega\n");
    expect(() => store.move("left")).not.toThrow();
    expect(store.getSnapshot().position.offset).toBe(0);

    expect(store.handleVimInput("", key({ rightArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().position.offset).toBe(1);
    expect(store.handleVimInput("", key({ leftArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().position.offset).toBe(0);
    expect(store.handleVimInput("", key({ downArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().position.line).toBe(2);
    expect(store.handleVimInput("", key({ upArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().position.line).toBe(1);
    expect(store.handleVimInput("", key({ backspace: true }), 80)).toBe(true);
    expect(store.getSnapshot().position.offset).toBe(0);
    expect(store.handleVimInput("", key({ delete: true }), 80)).toBe(true);
    expect(store.getText()).toBe("lpha\nomega\n");
  });

  it("lets normal-mode enter fall through to the buffer keybinding", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    expect(store.handleVimInput("", key({ return: true }), 80)).toBe(false);
    expect(store.getText()).toBe("alpha\nomega\n");
    expect(store.getSnapshot().vimMode).toBe("NORMAL");

    store.handleVimInput("i", key(), 80);
    expect(store.handleVimInput("", key({ return: true }), 80)).toBe(true);
    expect(store.getText()).toBe("\nalpha\nomega\n");
    expect(store.getSnapshot().vimMode).toBe("INSERT");
  });

  it("handles insert-mode editing controls and navigation fallthrough", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.handleVimInput("i", key(), 80)).toBe(true);
    expect(store.handleVimInput("", key({ rightArrow: true }), 80)).toBe(false);
    expect(store.handleVimInput("", key({ tab: true }), 80)).toBe(true);
    expect(store.handleVimInput("B", key({ shift: true }), 80)).toBe(true);
    expect(store.handleVimInput("", key({ backspace: true }), 80)).toBe(true);
    expect(store.handleVimInput("", key(), 80)).toBe(true);
    expect(store.getText()).toBe("\talpha\n");
    expect(store.getSnapshot().vimMode).toBe("INSERT");
  });

  it("keeps insert-mode Delete from erasing typed text from dot repeat", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput("i", key(), 80);
    store.handleVimInput("X", key({ shift: true }), 80);
    store.handleVimInput("", key({ delete: true }), 80);
    store.handleVimInput("", key({ escape: true, meta: true }), 80);
    expect(store.getText()).toBe("Xlpha\nomega\n");

    store.handleVimInput(".", key(), 80);

    expect(store.getText()).toBe("XXlpha\nomega\n");
  });

  it("lets normal-mode shifted arrows fall through to selection keybindings", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    expect(store.handleVimInput("", key({ shift: true, rightArrow: true }), 80)).toBe(false);
    expect(store.getSnapshot().selection).toEqual({ anchor: 0, head: 0 });

    // Idle NORMAL-mode esc bubbles out of the buffer (the workbench binding
    // sends focus back to the composer); only a pending vim command keeps it.
    expect(store.handleVimInput("", key({ escape: true }), 80)).toBe(false);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");

    expect(store.handleVimInput("", key({ rightArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().selection).toEqual({ anchor: 1, head: 1 });
  });

  it("keeps esc inside the buffer while a vim command is pending", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    // A pending operator (`d` waits for a motion) is cancellable with esc…
    expect(store.handleVimInput("d", key(), 80)).toBe(true);
    expect(store.handleVimInput("", key({ escape: true }), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    expect(store.getText()).toBe("alpha\nomega\n");

    // …and once it is consumed, the next esc bubbles out again.
    expect(store.handleVimInput("", key({ escape: true }), 80)).toBe(false);
  });

  it("supports visual selection yank, delete, change, and paste", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "abcdef\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput("v", key(), 80);
    expect(store.getSnapshot().vimMode).toBe("VISUAL");
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("l", key(), 80);
    expect(store.getSnapshot().selection).toEqual({ anchor: 0, head: 2 });

    store.handleVimInput("y", key(), 80);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    store.handleVimInput("$", key({ shift: true }), 80);
    store.handleVimInput("p", key(), 80);
    expect(store.getText()).toBe("abcdef\nabomega\n");

    store.close({ discard: true });
    await writeFile(file, "abcdef\nomega\n", "utf8");
    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.handleVimInput("v", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("d", key(), 80);
    expect(store.getText()).toBe("cdef\nomega\n");

    store.close({ discard: true });
    await writeFile(file, "abcdef\nomega\n", "utf8");
    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.handleVimInput("v", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("c", key(), 80);
    expect(store.getSnapshot().vimMode).toBe("INSERT");
    store.handleVimInput("Z", key({ shift: true }), 80);
    store.handleVimInput("", key({ escape: true, meta: true }), 80);
    expect(store.getText()).toBe("Zcdef\nomega\n");
  });

  it("handles visual-mode cancellation, empty paste, uppercase yank, and last-line motion", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "abcdef\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput("v", key(), 80);
    expect(store.handleVimInput("", key({ return: true }), 80)).toBe(true);
    expect(store.handleVimInput("r", key(), 80)).toBe(true);
    expect(store.handleVimInput("P", key({ shift: true }), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("VISUAL");

    expect(store.handleVimInput("G", key({ shift: true }), 80)).toBe(true);
    expect(store.getSnapshot().selection.head).toBe(13);
    expect(store.handleVimInput("Y", key({ shift: true }), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");

    store.handleVimInput("v", key(), 80);
    expect(store.handleVimInput("", key({ escape: true }), 80)).toBe(true);
    expect(store.getSnapshot().vimMode).toBe("NORMAL");
  });

  it("pastes a saved register over an active visual selection", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "abcdef\nomega\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput("v", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("y", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("v", key(), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput("P", key({ shift: true }), 80);

    expect(store.getSnapshot().vimMode).toBe("NORMAL");
    expect(store.getText()).toBe("abadef\nomega\n");
  });

  it("dot-repeats recorded vim changes from the buffer context", async () => {
    const openStore = async (text: string): Promise<WorkbenchBufferStore> => {
      const file = join(dir, `repeat-${Math.random().toString(36).slice(2)}.txt`);
      await writeFile(file, text, "utf8");
      const store = new WorkbenchBufferStore();
      await runWithCwdOverride(dir, () => store.open(file));
      return store;
    };

    let store = await openStore("abcd\n");
    store.handleVimInput("x", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("cd\n");
    store.handleVimInput("u", key(), 80);
    expect(store.getText()).toBe("bcd\n");

    store = await openStore("abcd\n");
    store.handleVimInput("r", key(), 80);
    store.handleVimInput("Z", key({ shift: true }), 80);
    store.handleVimInput("l", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("ZZcd\n");

    store = await openStore("ab\n");
    store.handleVimInput("~", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("AB\n");

    store = await openStore("a\nb\nc\n");
    store.handleVimInput("J", key({ shift: true }), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("a b c\n");

    store = await openStore("a\n");
    store.handleVimInput("o", key(), 80);
    store.handleVimInput("", key({ escape: true }), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("a\n\n\n");

    store = await openStore("a\n");
    store.handleVimInput(">", key({ shift: true }), 80);
    store.handleVimInput(">", key({ shift: true }), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("    a\n");

    store = await openStore("alpha beta gamma\n");
    store.handleVimInput("d", key(), 80);
    store.handleVimInput("w", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("gamma\n");

    store = await openStore("abcabc\n");
    store.handleVimInput("d", key(), 80);
    store.handleVimInput("f", key(), 80);
    store.handleVimInput("c", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("\n");

    store = await openStore("alpha beta\n");
    store.handleVimInput("d", key(), 80);
    store.handleVimInput("i", key(), 80);
    store.handleVimInput("w", key(), 80);
    store.handleVimInput(".", key(), 80);
    expect(store.getText()).toBe("beta\n");

    store = await openStore("abcabc\n");
    store.handleVimInput("f", key(), 80);
    store.handleVimInput("c", key(), 80);
    store.handleVimInput(";", key(), 80);
    expect(store.getSnapshot().position.offset).toBe(5);
  });

  it("supports vim command-line save and quit commands", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();
    const commands: BufferVimCommand[] = [];
    const handleCommand = (command: BufferVimCommand): void => {
      commands.push(command);
    };

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    expect(store.handleVimInput(":", key({ shift: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("");
    expect(store.handleVimInput("w", key(), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("w");
    expect(store.handleVimInput("", key({ return: true }), 80, handleCommand)).toBe(true);
    expect(commands.pop()).toEqual({ type: "save", force: false });
    expect(store.getSnapshot().vimCommandLine).toBeNull();

    store.handleVimInput(":", key({ shift: true }), 80, handleCommand);
    for (const char of "wq!") {
      store.handleVimInput(char, key({ shift: char === "!" }), 80, handleCommand);
    }
    store.handleVimInput("", key({ return: true }), 80, handleCommand);
    expect(commands.pop()).toEqual({ type: "saveQuit", force: true, all: false });

    store.handleVimInput(":", key({ shift: true }), 80, handleCommand);
    for (const char of "qa!") {
      store.handleVimInput(char, key({ shift: char === "!" }), 80, handleCommand);
    }
    store.handleVimInput("", key({ return: true }), 80, handleCommand);
    expect(commands.pop()).toEqual({ type: "quit", discard: true, all: true });
  });

  it("parses vim command-line aliases and editing controls", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();
    const commands: BufferVimCommand[] = [];
    const handleCommand = (command: BufferVimCommand): void => {
      commands.push(command);
    };
    const sendCommand = (command: string): void => {
      store.handleVimInput(":", key({ shift: true }), 80, handleCommand);
      for (const char of command) {
        store.handleVimInput(char, key({ shift: char === "!" }), 80, handleCommand);
      }
      store.handleVimInput("", key({ return: true }), 80, handleCommand);
    };

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput(":", key({ shift: true }), 80, handleCommand);
    for (const char of "write") {
      store.handleVimInput(char, key(), 80, handleCommand);
    }
    expect(store.getSnapshot().vimCommandLine).toBe("write");
    expect(store.handleVimInput("", key({ backspace: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("writ");
    expect(store.handleVimInput("", key({ delete: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("wri");
    store.handleVimInput("", key({ backspace: true }), 80, handleCommand);
    store.handleVimInput("", key({ backspace: true }), 80, handleCommand);
    store.handleVimInput("", key({ backspace: true }), 80, handleCommand);
    expect(store.getSnapshot().vimCommandLine).toBe("");
    expect(store.handleVimInput("", key({ backspace: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("");
    expect(store.handleVimInput("x", key({ meta: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBe("");
    expect(store.handleVimInput("", key(), 80, handleCommand)).toBe(true);
    expect(store.handleVimInput("", key({ escape: true }), 80, handleCommand)).toBe(true);
    expect(store.getSnapshot().vimCommandLine).toBeNull();

    for (const [raw, expected] of [
      ["write", { type: "save", force: false }],
      ["write!", { type: "save", force: true }],
      ["quit", { type: "quit", discard: false, all: false }],
      ["quit!", { type: "quit", discard: true, all: false }],
      ["qall", { type: "quit", discard: false, all: true }],
      ["quitall", { type: "quit", discard: false, all: true }],
      ["wq", { type: "saveQuit", force: false, all: false }],
      ["x", { type: "saveQuit", force: false, all: false }],
      ["xit", { type: "saveQuit", force: false, all: false }],
      ["exit", { type: "saveQuit", force: false, all: false }],
      ["x!", { type: "saveQuit", force: true, all: false }],
      ["xit!", { type: "saveQuit", force: true, all: false }],
      ["exit!", { type: "saveQuit", force: true, all: false }],
      ["wqa", { type: "saveQuit", force: false, all: true }],
      ["wqall", { type: "saveQuit", force: false, all: true }],
      ["xa", { type: "saveQuit", force: false, all: true }],
      ["xall", { type: "saveQuit", force: false, all: true }],
      ["wqa!", { type: "saveQuit", force: true, all: true }],
      ["wqall!", { type: "saveQuit", force: true, all: true }],
      ["xa!", { type: "saveQuit", force: true, all: true }],
      ["xall!", { type: "saveQuit", force: true, all: true }],
    ] as const) {
      sendCommand(raw);
      expect(commands.pop()).toEqual(expected);
    }
  });

  it("keeps unknown vim commands in the buffer status instead of leaking input", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput(":", key({ shift: true }), 80);
    for (const char of "nope") {
      store.handleVimInput(char, key(), 80);
    }
    store.handleVimInput("", key({ return: true }), 80);

    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: "Unknown Vim command: :nope",
      vimCommandLine: null,
    });
  });

  it("cancels the vim command line on Ctrl+C", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));

    store.handleVimInput(":", key({ shift: true }), 80);
    store.handleVimInput("w", key(), 80);

    expect(store.getSnapshot().vimCommandLine).toBe("w");
    expect(store.handleVimInput("c", key({ ctrl: true }), 80)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      error: null,
      vimCommandLine: null,
    });
    expect(store.getText()).toBe("alpha\n");
  });

  it("refuses to overwrite disk changes made after open", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    await writeFile(file, "external\n", "utf8");
    store.insert("draft ");

    await expect(store.save()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
    });
    expect(await readFile(file, "utf8")).toBe("external\n");
  });

  it("refuses to save while an agent is in flight for the file", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    store.insert("draft ");

    await expect(store.save({ hasInFlightAgent: true })).resolves.toBe(false);
    await expect(store.save({ hasInFlightAgent: true, force: true })).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "agent",
    });
    expect(await readFile(file, "utf8")).toBe("alpha\n");
  });

  it("reports deleted-file save conflicts", async () => {
    const file = join(dir, "target.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, () => store.open("target.txt"));
    await rm(file);
    store.insert("draft ");

    await expect(store.save()).resolves.toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictKind: "disk",
    });
  });

  it("rejects large and binary file snapshots", async () => {
    const large = join(dir, "large.txt");
    const binary = join(dir, "binary.bin");
    await writeFile(large, "too big", "utf8");
    await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));

    await runWithCwdOverride(dir, async () => {
      await expect(readBufferFileSnapshot(large, { maxBytes: 3 })).rejects.toBeInstanceOf(BufferFileTooLargeError);
      await expect(readBufferFileSnapshot(binary)).rejects.toBeInstanceOf(BufferBinaryFileError);
    });
  });
});
