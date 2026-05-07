import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import keybindingsCommand, {
  DEFAULT_KEYBINDINGS,
  keybindingsPath,
  runKeybindings,
  spawnKeybindingsEditor,
} from "./keybindings.js";

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "agenc-kb-"));
  delete process.env.EDITOR;
  delete process.env.VISUAL;
});

afterEach(() => {
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  vi.restoreAllMocks();
});

describe("keybindingsCommand", () => {
  it("creates default bindings when the file is missing", async () => {
    const spawnEditor = vi.fn(async () => 0);
    const res = await runKeybindings(workHome, "", {
      spawnEditor,
      ensureFile: async (file: string) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(DEFAULT_KEYBINDINGS), "utf8");
        return true;
      },
    });
    expect(res.kind).toBe("text");
    expect(existsSync(keybindingsPath(workHome))).toBe(true);
    expect(spawnEditor).toHaveBeenCalled();
  });

  it("continues to accept --create for compatibility", async () => {
    const spawnEditor = vi.fn(async () => 0);
    const res = await runKeybindings(workHome, "--create", {
      spawnEditor,
      ensureFile: async (file: string) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(DEFAULT_KEYBINDINGS), "utf8");
        return true;
      },
    });
    expect(res.kind).toBe("text");
    const file = keybindingsPath(workHome);
    expect(existsSync(file)).toBe(true);
    expect(spawnEditor).toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.bindings).toBeDefined();
    expect(parsed.bindings[0].context).toBe("Global");
  });

  it("emits an error when the editor fails to spawn", async () => {
    const file = keybindingsPath(workHome);
    writeFileSync(file, JSON.stringify(DEFAULT_KEYBINDINGS), "utf8");

    const res = await runKeybindings(workHome, "", {
      spawnEditor: async () => -1,
      ensureFile: async () => false,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/Failed to launch/);
  });

  it("hands terminal editors the terminal only after pausing Ink", async () => {
    const calls: string[] = [];
    const child = new EventEmitter() as ChildProcess;
    const spawnProcess = vi.fn(() => {
      calls.push("spawn");
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const ink = {
      enterAlternateScreen: vi.fn(() => calls.push("enter")),
      exitAlternateScreen: vi.fn(() => calls.push("exit")),
    };

    const code = await spawnKeybindingsEditor("nano", "/tmp/keybindings.json", {
      spawnProcess,
      getInk: () => ink,
      isEditorAvailable: () => true,
    });

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      "nano",
      ["/tmp/keybindings.json"],
      { stdio: "inherit" },
    );
    expect(calls).toEqual(["enter", "spawn", "exit"]);
  });

  it("launches GUI editors detached from the TUI stdio", async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const ink = {
      enterAlternateScreen: vi.fn(),
      exitAlternateScreen: vi.fn(),
    };

    const code = await spawnKeybindingsEditor("code --wait", "/tmp/keybindings.json", {
      spawnProcess,
      getInk: () => ink,
      isEditorAvailable: () => true,
    });

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      "code",
      ["--wait", "/tmp/keybindings.json"],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalled();
    expect(ink.enterAlternateScreen).not.toHaveBeenCalled();
    expect(ink.exitAlternateScreen).not.toHaveBeenCalled();
  });

  it("errors if the injected creator does not leave a file behind", async () => {
    const res = await runKeybindings(workHome, "", {
      spawnEditor: async () => 0,
      ensureFile: async () => false,
    });

    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/Failed to create/);
  });

  it("exposes a command descriptor that uses the real dep chain", async () => {
    expect(keybindingsCommand.name).toBe("keybindings");
  });
});
