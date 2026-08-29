import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readTextFile } from "./_deps/file-read.js";
import {
  readCanonicalUserConfigSnapshotSync,
  replaceCanonicalUserConfigTextSync,
} from "./update-sync.js";

export interface ConfigEditorSpawner {
  (command: string, args: readonly string[]): Promise<number>;
}

export interface CanonicalConfigEditorResult {
  readonly path: string;
  readonly editorCommand: string;
  readonly exitCode: number;
  readonly changed: boolean;
}

export function splitConfigEditorCommandLine(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  const push = (): void => {
    if (current.length > 0) {
      args.push(current);
      current = "";
    }
  };

  for (const char of raw.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote !== null) throw new Error("EDITOR contains an unterminated quote");
  push();
  return args;
}

export function parseConfigEditorCommand(raw: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const parts = splitConfigEditorCommandLine(raw);
  const command = parts[0]?.trim();
  if (command === undefined || command.length === 0) {
    throw new Error("EDITOR resolved to an empty command");
  }
  return { command, args: parts.slice(1) };
}

export const spawnConfigEditor: ConfigEditorSpawner = (command, args) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { stdio: "inherit" });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(127));
    } catch {
      resolve(127);
    }
  });

/**
 * Open a private snapshot, validate the edited document, then commit it through
 * the canonical locked/CAS writer. The live config file is never handed to the
 * editor directly.
 */
export async function editCanonicalUserConfig(options: {
  readonly path: string;
  readonly editor: string;
  readonly spawner?: ConfigEditorSpawner;
}): Promise<CanonicalConfigEditorResult> {
  const snapshot = readCanonicalUserConfigSnapshotSync(options.path);
  await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(
    join(dirname(snapshot.path), ".agenc-config-edit-"),
  );
  const tempPath = join(tempDir, basename(snapshot.path));
  const editor = parseConfigEditorCommand(options.editor);
  try {
    await writeFile(tempPath, snapshot.content, {
      encoding: "utf8",
      mode: snapshot.mode,
    });
    const exitCode = await (options.spawner ?? spawnConfigEditor)(
      editor.command,
      [...editor.args, tempPath],
    );
    if (exitCode !== 0) {
      return {
        path: snapshot.path,
        editorCommand: editor.command,
        exitCode,
        changed: false,
      };
    }
    const replacement = await readTextFile(tempPath);
    const changed = replaceCanonicalUserConfigTextSync(snapshot, replacement);
    return {
      path: snapshot.path,
      editorCommand: editor.command,
      exitCode,
      changed,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
