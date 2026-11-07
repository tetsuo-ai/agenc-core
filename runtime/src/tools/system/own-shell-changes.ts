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

/** Runs of characters a path can hold, between shell and code punctuation. */
const PATH_RUN = /[^\s'"`;&|<>(){}[\],:=$\\*?!]+/gu;
/** Quoted strings, whose contents may be a path with spaces or other separators. */
const QUOTED = /'([^']*)'|"((?:[^"\\]|\\.)*)"/gu;

/**
 * The paths a command names: every path-shaped word and every quoted string,
 * resolved against the command's directory. A path spelled through a variable,
 * a glob, `~` or a `cd` earlier in the command is not resolved and names nothing.
 */
export function commandNamedPaths(command: string, cwd: string): Set<string> {
  const words = new Set<string>();
  for (const match of command.matchAll(PATH_RUN)) words.add(match[0]);
  for (const match of command.matchAll(QUOTED)) {
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined && quoted.length > 0) words.add(quoted);
  }
  const bases = new Set([cwd]);
  try {
    bases.add(realpathSync(cwd));
  } catch {
    // The directory alone.
  }
  const paths = new Set<string>();
  for (const word of words) {
    if (isAbsolute(word)) {
      paths.add(resolve(word));
      continue;
    }
    for (const base of bases) paths.add(resolve(base, word));
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
  while (shellSessions.size > MAX_SHELL_SESSIONS) {
    const oldest = shellSessions.keys().next().value;
    if (oldest === undefined) break;
    shellSessions.delete(oldest);
  }
}

/**
 * The scope of a write_stdin call: only the input it sends, so a poll credits
 * no file (the process's own command was credited for its first window), and
 * input that names a path is resolved in the process's directory and sandbox.
 * An unknown process gets the poll's directory and sandbox.
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
  return {
    command: input,
    cwd: process?.cwd ?? pollCwd,
    runtimeSandbox: process === undefined ? pollSandbox : process.runtimeSandbox,
  };
}
