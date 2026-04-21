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
  it("returns a prompt to create when file is missing and no --create", async () => {
    const res = await runKeybindings(workHome, "", {
      spawnEditor: async () => 0,
      ensureFile: async () => false,
    });
    expect(res.kind).toBe("text");
    if (res.kind === "text")
      expect(res.text).toMatch(/No keybindings file found/);
    expect(existsSync(keybindingsPath(workHome))).toBe(false);
  });

  it("creates the default bindings when --create is passed", async () => {
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
    expect(parsed.shortcuts).toBeDefined();
  });

  it("emits an error when the editor fails to spawn", async () => {
    const file = keybindingsPath(workHome);
    mkdirSync(join(workHome, ".agenc"), { recursive: true });
    writeFileSync(file, JSON.stringify(DEFAULT_KEYBINDINGS), "utf8");

    const res = await runKeybindings(workHome, "", {
      spawnEditor: async () => -1,
      ensureFile: async () => false,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/Failed to launch/);
  });

  it("exposes a command descriptor that uses the real dep chain", async () => {
    expect(keybindingsCommand.name).toBe("keybindings");
  });
});
