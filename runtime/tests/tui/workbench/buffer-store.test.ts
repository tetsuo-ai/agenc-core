import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
