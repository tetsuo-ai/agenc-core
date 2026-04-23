/**
 * `/keybindings` — open `~/.agenc/keybindings.json` in `$EDITOR`.
 *
 * If the file is missing, emit a message inviting the user to create
 * it with a default bindings block. Actual editor launch uses
 * `child_process.spawn` with the inherited stdio so the user sees the
 * real editor UI; when `$EDITOR` is unset we fall back to `nano`.
 *
 * The default bindings map mirrors the shortcuts T11 wires in the TUI
 * layer (Shift+Tab → cycleMode, Ctrl+C → interrupt).
 *
 * @module
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export const DEFAULT_KEYBINDINGS = {
  shortcuts: [
    { keys: "Shift+Tab", action: "cycleMode", description: "Cycle Normal / Auto-Accept / Plan modes" },
    { keys: "Ctrl+C", action: "interrupt", description: "Interrupt the current turn" },
    { keys: "Ctrl+D", action: "exit", description: "Exit the session" },
    { keys: "Ctrl+G", action: "openPlan", description: "Open the active plan file" },
    { keys: "Ctrl+L", action: "clearScreen", description: "Clear the screen (history preserved)" },
  ],
};

export function keybindingsPath(home: string): string {
  return join(home, ".agenc", "keybindings.json");
}

export interface KeybindingsDeps {
  spawnEditor: (editor: string, file: string) => Promise<number>;
  ensureFile: (file: string) => Promise<boolean>;
}

function defaultSpawnEditor(editor: string, file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(editor, [file], { stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function defaultEnsureFile(file: string): Promise<boolean> {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(DEFAULT_KEYBINDINGS, null, 2) + "\n", "utf8");
  return true;
}

/** Parse `--create` so we can offer the non-interactive create path. */
function wantsCreate(argsRaw: string): boolean {
  return /(^|\s)--create(\s|$)/.test(argsRaw);
}

export async function runKeybindings(
  home: string,
  argsRaw: string,
  deps: KeybindingsDeps = {
    spawnEditor: defaultSpawnEditor,
    ensureFile: defaultEnsureFile,
  },
): Promise<SlashCommandResult> {
  const file = keybindingsPath(home);

  if (!existsSync(file)) {
    if (!wantsCreate(argsRaw)) {
      return {
        kind: "text",
        text:
          `No keybindings file found at ${file}.\n` +
          `Re-run \`/keybindings --create\` to scaffold the default bindings, then edit.`,
      };
    }
    await deps.ensureFile(file);
  }

  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const code = await deps.spawnEditor(editor, file);
  if (code === 0) {
    return { kind: "text", text: `Opened ${file} in ${editor}.` };
  }
  if (code < 0) {
    return {
      kind: "error",
      message: `Failed to launch ${editor} for ${file}.`,
    };
  }
  return {
    kind: "text",
    text: `${editor} exited with code ${code} for ${file}.`,
  };
}

export const keybindingsCommand: SlashCommand = {
  name: "keybindings",
  description: "Edit ~/.agenc/keybindings.json in $EDITOR",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runKeybindings(ctx.home, ctx.argsRaw)),
};

export default keybindingsCommand;
