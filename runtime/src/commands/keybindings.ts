/**
 * `/keybindings` — open `keybindings.json` in AgenC home.
 *
 * If the file is missing, scaffold the default bindings before opening
 * it. Actual editor launch uses `child_process.spawn` with inherited
 * stdio so the user sees the real editor UI; when `$EDITOR` is unset
 * we fall back to `nano`.
 *
 * The default file uses AgenC's live keybinding schema, which mirrors
 * AgenC's `{ bindings: [{ context, bindings }] }` structure with
 * AgenC action names and `~/.agenc` storage.
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
  $schema: "urn:agenc:schema:keybindings",
  $docs: "urn:agenc:docs:keybindings",
  bindings: [
    {
      context: "Global",
      bindings: {
        "ctrl+c": "app:interrupt",
        "ctrl+d": "app:exit",
        "ctrl+l": "app:redraw",
        "ctrl+o": "app:toggleTranscript",
        "ctrl+r": "history:search",
        pageup: "scroll:pageUp",
        pagedown: "scroll:pageDown",
        wheelup: "scroll:lineUp",
        wheeldown: "scroll:lineDown",
        "ctrl+home": "scroll:top",
        "ctrl+end": "scroll:bottom",
      },
    },
    {
      context: "Chat",
      bindings: {
        "shift+tab": "chat:cycleMode",
        enter: "chat:submit",
        tab: "chat:acceptSuggestion",
        "shift+enter": "chat:newline",
        "ctrl+j": "chat:newline",
        escape: "chat:cancel",
        up: "history:prev",
        down: "history:next",
        "ctrl+x ctrl+e": "chat:externalEditor",
        "ctrl+v": "chat:imagePaste",
        "alt+v": "chat:imagePaste",
      },
    },
    {
      context: "Confirmation",
      bindings: {
        enter: "modal:confirm",
        escape: "modal:cancel",
        y: "modal:yes",
        n: "modal:no",
        a: "modal:allowSession",
        d: "modal:deny",
      },
    },
    {
      context: "Transcript",
      bindings: {
        "ctrl+e": "transcript:toggleShowAll",
        "ctrl+c": "transcript:exit",
        escape: "transcript:exit",
        q: "transcript:exit",
        up: "scroll:lineUp",
        down: "scroll:lineDown",
        k: "scroll:lineUp",
        j: "scroll:lineDown",
        "ctrl+p": "scroll:lineUp",
        "ctrl+n": "scroll:lineDown",
        pageup: "scroll:pageUp",
        pagedown: "scroll:pageDown",
        "ctrl+u": "scroll:halfPageUp",
        "ctrl+d": "scroll:halfPageDown",
        "ctrl+b": "scroll:fullPageUp",
        "ctrl+f": "scroll:fullPageDown",
        b: "scroll:fullPageUp",
        space: "scroll:fullPageDown",
        home: "scroll:top",
        end: "scroll:bottom",
        g: "scroll:top",
        "shift+g": "scroll:bottom",
      },
    },
  ],
};

export function keybindingsPath(agencHome: string): string {
  return join(agencHome, "keybindings.json");
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

function agencHomeFromCtx(ctx: SlashCommandContext): string {
  return ctx.agencHome ?? join(ctx.home, ".agenc");
}

export async function runKeybindings(
  agencHome: string,
  _argsRaw: string,
  deps: KeybindingsDeps = {
    spawnEditor: defaultSpawnEditor,
    ensureFile: defaultEnsureFile,
  },
): Promise<SlashCommandResult> {
  const file = keybindingsPath(agencHome);

  if (!existsSync(file)) {
    await deps.ensureFile(file);
    if (!existsSync(file)) {
      return {
        kind: "error",
        message: `Failed to create keybindings file at ${file}.`,
      };
    }
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
  description: "Edit keybindings.json in $EDITOR",
  supportsNonInteractive: false,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runKeybindings(agencHomeFromCtx(ctx), ctx.argsRaw)),
};

export default keybindingsCommand;
