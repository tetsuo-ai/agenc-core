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
import { type BufferVimCommand, WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
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

    expect(store.handleVimInput("", key({ rightArrow: true }), 80)).toBe(true);
    expect(store.getSnapshot().selection).toEqual({ anchor: 1, head: 1 });
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

    await expect(readBufferFileSnapshot(large, { maxBytes: 3 })).rejects.toBeInstanceOf(BufferFileTooLargeError);
    await expect(readBufferFileSnapshot(binary)).rejects.toBeInstanceOf(BufferBinaryFileError);
  });
});
