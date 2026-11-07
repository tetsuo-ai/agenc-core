/**
 * Changes the session's own shell commands make to files it has read.
 *
 * AgenC's file tools (Write, Edit, apply_patch, NotebookEdit) record what they
 * wrote as the session's view of the file, so the changed-files attachment
 * producer (`prompts/attachments/changed-files.ts`) never sends their writes
 * back to the model. A shell command records nothing, so every shell change to
 * a file the session had read came back as a "changed file" diff on the next
 * request and stayed in every later request: a CSV the model appended to with
 * `printf >>` once per item was sent again after each append.
 *
 * A shell tool runs its command inside {@link trackOwnShellChanges} with the
 * command's text, directory and sandbox. A read file is credited to the command
 * only when the command names its path (a path-shaped word or quoted string of
 * the command, or of the input a write_stdin call sends, resolves to it), the
 * sandbox lets the command write it, and its disk state when the command starts
 * is one the producer has accounted for (the state it last found matching the session's view, or the
 * state an earlier credited command left). When the command returns, each such
 * file whose state moved is recorded with its new state. The producer then
 * sends nothing for the file while it keeps exactly that state, and leaves the
 * session's view on the bytes the model last saw, so a Write or Edit of the file
 * still asks for a read first. Every other change, during the command or not,
 * is sent as before.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canWritePathWithCwd } from "../../sandbox/engine/policy.js";
import { effectivePermissionProfile } from "../../sandbox/engine/policy-transforms.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import {
  fileStatFingerprint,
  fileViewStateOf,
  forEachSessionRead,
  recordOwnShellChange,
  resolveSessionId,
  sameFileStat,
  type FileStatFingerprint,
} from "./filesystem.js";

/**
 * What one shell call runs: its text (for a write_stdin call, only the input it
 * sends), the directory its relative paths resolve against, and the sandbox it
 * runs in (undefined: no OS sandbox).
 */
export interface ShellCommandScope {
  readonly command: string;
  readonly cwd: string;
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox | undefined;
}

/** Commands that move a shell to another directory: relative paths after one cannot be resolved here. */
const DIRECTORY_CHANGES: ReadonlySet<string> = new Set([
  "cd", "pushd", "popd", "chdir", "set-location", "sl", "push-location", "pop-location",
]);

interface ShellWord {
  readonly text: string;
  /** The word may expand (variable, command substitution, glob, braces, `~`) or holds a backslash. */
  readonly unresolvable: boolean;
}

const OPERATOR = /[;&|<>()]/u;
const GLOB = /[*?[\]{}]/u;

/**
 * The words of a command text as a POSIX shell splits them (whitespace and
 * operators outside quotes separate words; quotes are removed; `#` starts a
 * comment at a word start). Heredoc bodies are split the same way, which keeps
 * a quoted path inside a script a word of its own.
 */
export function shellWords(text: string, platform: NodeJS.Platform = process.platform): ShellWord[] {
  const words: ShellWord[] = [];
  let word = "";
  let started = false;
  let unresolvable = false;
  const end = (): void => {
    if (started) words.push({ text: word, unresolvable });
    word = "";
    started = false;
    unresolvable = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/u.test(char) || OPERATOR.test(char)) {
      end();
      continue;
    }
    if (char === "#" && !started) {
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    started = true;
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const quoted = text.slice(index + 1, close < 0 ? text.length : close);
      if (quoted.includes("\\")) unresolvable = true;
      word += quoted;
      index = close < 0 ? text.length : close;
      continue;
    }
    if (char === "\"") {
      let close = index + 1;
      while (close < text.length && text[close] !== "\"") {
        if (text[close] === "\\") {
          unresolvable = true;
          close += 1;
        } else if (text[close] === "$" || text[close] === "`") {
          unresolvable = true;
        }
        close += 1;
      }
      word += text.slice(index + 1, Math.min(close, text.length));
      index = close;
      continue;
    }
    if (char === "\\") {
      // A path piece with a backslash names nothing on POSIX, where it escapes
      // the next character (kept in the same word) instead of separating names.
      word += char;
      if (platform !== "win32") {
        unresolvable = true;
        if (index + 1 < text.length) {
          index += 1;
          word += text[index];
        }
      }
      continue;
    }
    if (char === "$" || char === "`" || GLOB.test(char) || (char === "~" && word.length === 0)) {
      unresolvable = true;
    }
    word += char;
  }
  end();
  return words;
}

/** Whether a command (or a shell's input) may move the shell to another directory. */
export function changesDirectory(command: string): boolean {
  return /chdir/iu.test(command) ||
    shellWords(command).some((word) => DIRECTORY_CHANGES.has(word.text.toLowerCase()));
}

/**
 * The paths a command names: each whole shell word that is a plain path (no
 * expansion, no backslash on POSIX), resolved against the real working
 * directory. A command that may change directory names nothing, and so does a
 * command whose working directory cannot be resolved.
 */
export function commandNamedPaths(command: string, cwd: string): Set<string> {
  const paths = new Set<string>();
  if (command.length === 0 || changesDirectory(command)) return paths;
  let base: string;
  try {
    base = realpathSync(cwd);
  } catch {
    return paths;
  }
  for (const word of shellWords(command)) {
    if (word.unresolvable || word.text.length === 0) continue;
    paths.add(isAbsolute(word.text) ? resolve(word.text) : resolve(base, word.text));
  }
  return paths;
}

/** Whether the effective sandbox (after any granted escalation or extra permission) lets the command write `path`. */
export function sandboxMayWrite(
  runtimeSandbox: UnifiedExecRuntimeSandbox | undefined,
  path: string,
): boolean {
  if (runtimeSandbox === undefined) return true;
  try {
    const profile = effectivePermissionProfile(
      runtimeSandbox.permissionProfile,
      runtimeSandbox.additionalPermissions,
    );
    return canWritePathWithCwd(
      profile.fileSystem,
      path,
      runtimeSandbox.sandboxPolicyCwd,
      runtimeSandbox.sessionTempRoot,
    );
  } catch {
    return false;
  }
}

async function statFingerprint(path: string): Promise<FileStatFingerprint | undefined> {
  try {
    return fileStatFingerprint(await stat(path));
  } catch {
    return undefined;
  }
}

/** Read files the command names and may write, whose state the producer has accounted for. */
async function creditableFiles(
  sessionId: string,
  scope: ShellCommandScope,
): Promise<Map<string, FileStatFingerprint>> {
  const named: Array<{ readonly path: string; readonly bytes: number }> = [];
  if (scope.command.length === 0) return new Map();
  const paths = commandNamedPaths(scope.command, scope.cwd);
  forEachSessionRead(sessionId, (path, snapshot) => {
    // The producer's own selection: full views that carry their raw bytes.
    if (typeof snapshot.rawContent !== "string" || snapshot.isPartialView === true) return;
    if (!paths.has(path) || !sandboxMayWrite(scope.runtimeSandbox, path)) return;
    named.push({ path, bytes: Buffer.byteLength(snapshot.rawContent, "utf8") });
  });
  const inView = new Map<string, FileStatFingerprint>();
  await Promise.all(
    named.map(async ({ path, bytes }) => {
      const now = await statFingerprint(path);
      if (now === undefined) return;
      const state = fileViewStateOf(sessionId, path);
      // The size check keeps a change that kept an old modification time (cp -p, rsync -t)
      // out of the view state the producer recorded from timestamps.
      const matchesView = sameFileStat(now, state?.view) && (bytes === now.size || isImageSnapshot(path));
      if (matchesView || sameFileStat(now, state?.own)) inView.set(path, now);
    }),
  );
  return inView;
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp)$/iu;

/** Image snapshots hold base64, whose length is not the file size. */
function isImageSnapshot(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

/**
 * Run one shell call of the session (`run`) and record which read files it
 * changed (see the module comment). Without a session id it only runs the call.
 */
export async function trackOwnShellChanges<T>(
  args: Record<string, unknown>,
  scope: ShellCommandScope,
  run: () => Promise<T>,
): Promise<T> {
  const sessionId = resolveSessionId(args);
  const before = sessionId === undefined ? undefined : await creditableFiles(sessionId, scope);
  try {
    return await run();
  } finally {
    if (sessionId !== undefined && before !== undefined && before.size > 0) {
      await Promise.all(
        [...before].map(async ([path, previous]) => {
          const after = await statFingerprint(path);
          if (after !== undefined && !sameFileStat(after, previous)) {
            recordOwnShellChange(sessionId, path, after);
          }
        }),
      );
    }
  }
}

/**
 * The directory and sandbox of each process an exec call left running, for the
 * input a later write_stdin call sends it. Keyed by the session id and the exec
 * session id; bounded, oldest dropped first.
 */
const shellSessions = new Map<string, ShellCommandScope>();
/** Exec sessions whose shell may have changed directory since it started: their input names nothing. */
const movedShellSessions = new Set<string>();
const MAX_SHELL_SESSIONS = 512;

function shellSessionKey(args: Record<string, unknown>, execSessionId: number): string | undefined {
  const sessionId = resolveSessionId(args);
  return sessionId === undefined ? undefined : `${sessionId}\u0000${execSessionId}`;
}

export function rememberShellSession(
  args: Record<string, unknown>,
  execSessionId: number | undefined,
  scope: ShellCommandScope,
): void {
  if (execSessionId === undefined) return;
  const key = shellSessionKey(args, execSessionId);
  if (key === undefined) return;
  shellSessions.delete(key);
  shellSessions.set(key, scope);
  if (changesDirectory(scope.command)) movedShellSessions.add(key);
  else movedShellSessions.delete(key);
  while (shellSessions.size > MAX_SHELL_SESSIONS) {
    const oldest = shellSessions.keys().next().value;
    if (oldest === undefined) break;
    shellSessions.delete(oldest);
    movedShellSessions.delete(oldest);
  }
}

/**
 * The scope of a write_stdin call: only the input it sends, so a poll credits
 * no file (the process's own command was credited for its first window), and
 * input that names a path is resolved in the process's directory and sandbox.
 * Input to a process this session did not start here, or to a shell that may
 * have changed directory (its command or any input so far could move it),
 * names nothing.
 */
export function polledShellScope(
  args: Record<string, unknown>,
  execSessionId: number,
  input: string,
  pollCwd: string,
  pollSandbox: UnifiedExecRuntimeSandbox | undefined,
): ShellCommandScope {
  const key = shellSessionKey(args, execSessionId);
  const process = key === undefined ? undefined : shellSessions.get(key);
  if (key !== undefined && process !== undefined && changesDirectory(input)) movedShellSessions.add(key);
  const directoryKnown = key !== undefined && process !== undefined && !movedShellSessions.has(key);
  return {
    command: directoryKnown ? input : "",
    cwd: process?.cwd ?? pollCwd,
    runtimeSandbox: process === undefined ? pollSandbox : process.runtimeSandbox,
  };
}
