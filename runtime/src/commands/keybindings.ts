/**
 * `/keybindings` — open `keybindings.json` in AgenC home.
 *
 * If the file is missing, scaffold the default bindings before opening
 * it. Terminal editors use Ink's terminal handoff before receiving stdio;
 * GUI editors are detached from the TUI's stdio. When `$EDITOR` is unset
 * we fall back to `nano`.
 *
 * The default file uses AgenC's live keybinding schema, which mirrors
 * AgenC's `{ bindings: [{ context, bindings }] }` structure with
 * AgenC action names and `~/.agenc` storage.
 *
 * @module
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  classifyGuiEditor,
  editorExecutableAvailable,
  splitEditorCommand,
} from "../utils/editor.js";
import { getInkInstance } from "../tui/ink/instances.js";
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
    // ctrl+c, ctrl+d, ctrl+m are intentionally omitted from the
    // scaffolded user config — they are NON_REBINDABLE
    // (reservedShortcuts.ts) and writing them here just triggers
    // "reserved" warnings on every startup. The runtime defaults in
    // tui/keybindings/defaultBindings.ts handle ctrl+c → app:interrupt
    // and ctrl+d → app:exit unconditionally.
    {
      context: "Global",
      bindings: {
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
      // ctrl+c is omitted — runtime default handles it as transcript:exit.
      // ctrl+d is omitted — NON_REBINDABLE (always exits the app).
      context: "Transcript",
      bindings: {
        "ctrl+e": "transcript:toggleShowAll",
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

interface KeybindingsInkHandoff {
  enterAlternateScreen(): void;
  exitAlternateScreen(): void;
}

interface SpawnKeybindingsEditorDeps {
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  getInk?: () => KeybindingsInkHandoff | undefined;
  isEditorAvailable?: (base: string) => boolean;
}

function waitForEditorExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function waitForGuiEditorLaunch(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("spawn", () => {
      child.unref();
      resolve(0);
    });
  });
}

export async function spawnKeybindingsEditor(
  editor: string,
  file: string,
  deps: SpawnKeybindingsEditorDeps = {},
): Promise<number> {
  const { base, editorArgs } = splitEditorCommand(editor);
  const isAvailable = deps.isEditorAvailable ?? editorExecutableAvailable;
  if (!isAvailable(base)) return -1;

  const args = [...editorArgs, file];
  const spawnProcess = deps.spawnProcess ?? spawn;
  const guiEditor = classifyGuiEditor(editor) !== undefined;
  if (guiEditor) {
    try {
      const child = spawnProcess(base, args, {
        detached: true,
        stdio: "ignore",
      });
      return await waitForGuiEditorLaunch(child);
    } catch {
      return -1;
    }
  }

  const ink = deps.getInk?.() ?? getInkInstance();
  ink?.enterAlternateScreen();
  try {
    const child = spawnProcess(base, args, { stdio: "inherit" });
    return await waitForEditorExit(child);
  } catch {
    return -1;
  } finally {
    ink?.exitAlternateScreen();
  }
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
    spawnEditor: spawnKeybindingsEditor,
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
