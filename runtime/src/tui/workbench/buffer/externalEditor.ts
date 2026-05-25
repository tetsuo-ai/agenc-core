import type { SpawnSyncOptions } from "node:child_process";
import { basename } from "node:path";
import crossSpawn from "cross-spawn";

import instances from "../../ink/instances.js";
import { classifyGuiEditor, editorExecutableAvailable, splitEditorCommand } from "../../../utils/editor.js";
import { whichSync } from "../../../utils/which.js";

type InkInstance = {
  readonly enterAlternateScreen: () => void;
  readonly exitAlternateScreen: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly suspendStdin: () => void;
  readonly resumeStdin: () => void;
};

export type BufferExternalEditorLauncher = (filePath: string, line?: number) => boolean;
type BufferExternalEditorEnv = {
  readonly VISUAL?: string;
  readonly EDITOR?: string;
};

export const BUFFER_EXTERNAL_EDITOR_FALLBACKS = ["nvim", "vim", "vi", "nano"] as const;

const PLUS_N_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/u;
const VSCODE_FAMILY = new Set(["code", "cursor", "windsurf", "codium"]);
const GUI_WAIT_ARGS = new Map<string, readonly string[]>([
  ["code", ["-w"]],
  ["cursor", ["-w"]],
  ["windsurf", ["-w"]],
  ["codium", ["-w"]],
  ["subl", ["--wait"]],
]);

export function resolveBufferExternalEditor(
  env: BufferExternalEditorEnv = process.env,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly isCommandAvailable?: (command: string) => boolean;
  } = {},
): string | undefined {
  const visual = env.VISUAL?.trim();
  if (visual) return visual;

  const editor = env.EDITOR?.trim();
  if (editor) return editor;

  if ((options.platform ?? process.platform) === "win32") return "notepad";

  const isCommandAvailable = options.isCommandAvailable ?? ((command: string) => Boolean(whichSync(command)));
  return BUFFER_EXTERNAL_EDITOR_FALLBACKS.find((command) => isCommandAvailable(command));
}

export function openFileInBufferExternalEditor(filePath: string, line?: number): boolean {
  const editor = resolveBufferExternalEditor();
  if (!editor) return false;

  const { base, editorArgs } = splitEditorCommand(editor);
  if (!editorExecutableAvailable(base)) return false;

  const inkInstance = instances.get(process.stdout) as InkInstance | undefined;
  if (!inkInstance) return false;

  const guiFamily = classifyGuiEditor(editor);
  const args = guiFamily
    ? [...waitArgsForGuiEditor(guiFamily, editorArgs), ...guiGotoArgv(guiFamily, filePath, line)]
    : [...editorArgs, ...terminalGotoArgv(base, filePath, line)];
  const syncOpts: SpawnSyncOptions = { stdio: "inherit" };

  let paused = false;
  let suspendedStdin = false;
  let enteredAlternateScreen = false;
  try {
    if (guiFamily) {
      inkInstance.pause();
      paused = true;
      inkInstance.suspendStdin();
      suspendedStdin = true;
    } else {
      inkInstance.enterAlternateScreen();
      enteredAlternateScreen = true;
    }
    const result = crossSpawn.sync(base, args, syncOpts);
    return !result.error && result.status === 0 && !result.signal;
  } catch {
    return false;
  } finally {
    if (guiFamily) {
      if (suspendedStdin) inkInstance.resumeStdin();
      if (paused) inkInstance.resume();
    } else if (enteredAlternateScreen) {
      inkInstance.exitAlternateScreen();
    }
  }
}

function waitArgsForGuiEditor(guiFamily: string, editorArgs: readonly string[]): readonly string[] {
  if (editorArgs.some((arg) => arg === "-w" || arg === "--wait" || arg === "--wait-for-window-close")) {
    return editorArgs;
  }
  return [...editorArgs, ...(GUI_WAIT_ARGS.get(guiFamily) ?? [])];
}

function guiGotoArgv(guiFamily: string, filePath: string, line: number | undefined): string[] {
  if (!line) return [filePath];
  if (VSCODE_FAMILY.has(guiFamily)) return ["-g", `${filePath}:${line}`];
  if (guiFamily === "subl") return [`${filePath}:${line}`];
  return [filePath];
}

function terminalGotoArgv(base: string, filePath: string, line: number | undefined): string[] {
  return line && PLUS_N_EDITORS.test(basename(base))
    ? [`+${line}`, filePath]
    : [filePath];
}
