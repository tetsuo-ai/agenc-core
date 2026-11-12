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
 * only when all of these hold: a whole shell word of the command (for a
 * write_stdin call, of the input it sends) resolves to the file's path in the
 * real working directory; that word cannot expand and, on POSIX, holds no
 * backslash; the command cannot change directory (no cd, pushd, popd or the
 * like, and for write_stdin none in the shell's command or any earlier input);
 * the sandbox lets the command write the file; and the file's disk state when
 * the command starts is one the producer has accounted for (the state it last
 * found matching the session's view, or the state an earlier credited command
 * left). When the command returns, each such file whose state moved is recorded
 * with its new state. While the file keeps exactly that state, the producer
 * sends one short notice for it instead of its contents and leaves the
 * session's view on the bytes the model last saw, so a Write or Edit of the
 * file still asks for a read first. Every other change, during the command or
 * not, is sent as before.
 *
 * A file a command wrote whole from a here-document whose delimiter is quoted
 * (no expansion) is recorded too, when its bytes after the command equal that
 * body exactly, whether the command created it or rewrote it: the model wrote
 * every byte of it in the command. When there is no earlier read and the file
 * keeps exactly that state, a Write, Edit or apply_patch may count it as read
 * ({@link proveOwnShellWrite}). An existing read takes precedence: rewriting
 * its bytes leaves that read stale, so an edit requires a fresh Read first.
 * A file a command created any other way (a redirect of other output, a copy,
 * a download, another writer while the command ran), changed, appended to, or
 * changed again after writing it, still needs a read: the model has not seen
 * its bytes. The changed-files attachment does not watch such a file until a
 * file tool writes it.
 *
 * @module
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canWritePathWithCwd } from "../../sandbox/engine/policy.js";
import { effectivePermissionProfile } from "../../sandbox/engine/policy-transforms.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import {
  fileStatFingerprint,
  fileViewStateOf,
  forEachSessionRead,
  forgetOwnShellWrite,
  ownShellWriteOf,
  recordOwnShellChange,
  recordOwnShellWrite,
  recordSessionRead,
  resolveSessionId,
  safePathAllowingSessionPlanFile,
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
  paths: ReadonlySet<string>,
): Promise<Map<string, FileStatFingerprint>> {
  const named: Array<{ readonly path: string; readonly bytes: number }> = [];
  if (paths.size === 0) return new Map();
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
 * A file a command wrote whole from a here-document whose delimiter is quoted
 * (`'EOF'`, `"EOF"` or `\EOF`): the shell writes the body without any
 * expansion, so the file gets exactly the text the command shows. Only
 * `cat > file` (in either order around the here-document) and `tee file`
 * write it; `>>` appends and is not one.
 */
export interface VerbatimWrite {
  /** The target word as the command wrote it, quotes removed. */
  readonly target: string;
  /** What the shell writes: the body lines, each ending in a newline. */
  readonly text: string;
}

/** A here-document operator (not a here-string) and its delimiter word, quoted or not. */
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\([^\s;&|<>()'"\\]+)|([^\s;&|<>()'"\\]+))/gu;
const SEGMENT_BREAK = /[;&|]/u;

/** The simple command around a here-document operator on its line: from the previous `;`, `&` or `|` to the next. */
function segmentAround(line: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !SEGMENT_BREAK.test(line[from - 1]!)) from -= 1;
  let to = end;
  while (to < line.length && !SEGMENT_BREAK.test(line[to]!)) to += 1;
  return `${line.slice(from, start)} ${line.slice(end, to)}`;
}

/** The file a `cat > file` or `tee file` segment writes its standard input to, or undefined. */
function verbatimTarget(segment: string): string | undefined {
  const tee = /^\s*tee\s+([^\s;&|<>()-][^\s;&|<>()]*)\s*(?:>[ \t]*\/dev\/null\s*)?$/u.exec(segment);
  if (tee !== null) return plainWord(tee[1]!);
  const redirect = /(?:^|\s)1?>(?![>&|])[ \t]*([^\s;&|<>()]+)/u.exec(segment);
  if (redirect === null) return undefined;
  // Nothing else may be read: `cat a - > f` would write a's bytes too.
  const rest = `${segment.slice(0, redirect.index)} ${segment.slice(redirect.index + redirect[0].length)}`;
  return /^\s*cat\s*$/u.test(rest) ? plainWord(redirect[1]!) : undefined;
}

/** One plain path word, quotes removed; undefined when it may expand or holds more than one word. */
function plainWord(raw: string): string | undefined {
  const words = shellWords(raw);
  return words.length === 1 && !words[0]!.unresolvable && words[0]!.text.length > 0 ? words[0]!.text : undefined;
}

/**
 * The quoted here-documents of a command and the files they write whole. A
 * here-document without its closing line, or after one, ends the scan.
 */
export function verbatimWrites(command: string): VerbatimWrite[] {
  if (!command.includes("<<")) return [];
  const lines = command.split("\n");
  const writes: VerbatimWrite[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    for (const operator of line.matchAll(HEREDOC_OPERATOR)) {
      const stripTabs = operator[1] === "-";
      const quoted = operator[2] ?? operator[3] ?? operator[4];
      const delimiter = quoted ?? operator[5]!;
      // Every here-document's body follows the line in order, quoted or not.
      const body: string[] = [];
      let closed = false;
      while (index < lines.length) {
        const bodyLine = stripTabs ? lines[index]!.replace(/^\t+/u, "") : lines[index]!;
        index += 1;
        if (bodyLine === delimiter) {
          closed = true;
          break;
        }
        body.push(bodyLine);
      }
      if (!closed) return writes;
      if (quoted === undefined || delimiter.length === 0) continue;
      const target = verbatimTarget(segmentAround(line, operator.index, operator.index + operator[0].length));
      if (target === undefined) continue;
      writes.push({ target, text: body.length === 0 ? "" : `${body.join("\n")}\n` });
    }
  }
  return writes;
}

/** Largest file a verbatim write is compared against. */
const VERBATIM_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Record each file a quoted here-document of the command names whose bytes,
 * when the command returns, equal that here-document's text: the session's own
 * command wrote all of it, whether it created the file or rewrote it whole. The
 * comparison reads one descriptor that does not follow a symlink, between two
 * equal stats.
 */
function recordVerbatimWrites(sessionId: string, scope: ShellCommandScope): void {
  const writes = verbatimWrites(scope.command);
  if (writes.length === 0 || changesDirectory(scope.command)) return;
  let base: string;
  try {
    base = realpathSync(scope.cwd);
  } catch {
    return;
  }
  for (const write of writes) {
    const expected = Buffer.from(write.text, "utf8");
    if (expected.length > VERBATIM_MAX_BYTES) continue;
    const path = isAbsolute(write.target) ? resolve(write.target) : resolve(base, write.target);
    let fd: number | undefined;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== expected.length) continue;
      const bytes = Buffer.alloc(expected.length + 1);
      let filled = 0;
      while (filled < bytes.length) {
        const read = readSync(fd, bytes, filled, bytes.length - filled, filled);
        if (read === 0) break;
        filled += read;
      }
      if (filled !== expected.length || !bytes.subarray(0, filled).equals(expected)) continue;
      const after = fileStatFingerprint(fstatSync(fd));
      if (!sameFileStat(fileStatFingerprint(before), after)) continue;
      const canonical = realpathSync(path);
      recordOwnShellWrite(sessionId, process.platform === "win32" ? canonical.normalize("NFC") : canonical, after);
    } catch {
      // A target that cannot be read as a regular file is not recorded.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/**
 * Run one shell call of the session (`run`) and record which read files it
 * changed and which files it wrote whole from a quoted here-document (see the
 * module comment). Without a session id it only runs the call.
 */
export async function trackOwnShellChanges<T>(
  args: Record<string, unknown>,
  scope: ShellCommandScope,
  run: () => Promise<T>,
): Promise<T> {
  const sessionId = resolveSessionId(args);
  const named = sessionId === undefined || scope.command.length === 0
    ? new Set<string>()
    : commandNamedPaths(scope.command, scope.cwd);
  const before = sessionId === undefined ? undefined : await creditableFiles(sessionId, scope, named);
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
    if (sessionId !== undefined) recordVerbatimWrites(sessionId, scope);
  }
}

/** Largest file a Write or Edit may count as read without a FileRead. */
const WRITE_PROOF_MAX_BYTES = 2 * 1024 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text of a file a command of the session made, read from one descriptor
 * that does not follow a symlink, when its state before and after the read is
 * the state its command left; undefined for anything else (changed since,
 * binary, too large).
 */
async function writtenFileText(
  path: string,
  written: FileStatFingerprint,
): Promise<string | undefined> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > WRITE_PROOF_MAX_BYTES ||
        !sameFileStat(fileStatFingerprint(before), written)) return undefined;
    // At most the stat size plus one byte: a file that grew is refused.
    const buffer = Buffer.alloc(before.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== before.size) return undefined;
    if (!sameFileStat(fileStatFingerprint(await handle.stat()), written)) return undefined;
    const bytes = buffer.subarray(0, filled);
    if (bytes.includes(0)) return undefined;
    return STRICT_UTF8.decode(bytes);
  } finally {
    await handle.close();
  }
}

/** Whether a command of the session recorded making `canonicalPath`. Path check only, for the preflight. */
export function mayProveOwnShellWrite(sessionId: string, canonicalPath: string): boolean {
  return ownShellWriteOf(sessionId, canonicalPath) !== undefined;
}

/**
 * Counts `file` as read when a command of the session wrote it whole from a
 * quoted here-document and it still has exactly the state that command left:
 * the model wrote every byte of it.
 * Records the read as a full view of its current text, as a FileRead would, so
 * the write's own drift checks apply. Returns whether the read was recorded.
 */
export async function proveOwnShellWrite(
  sessionId: string,
  file: string,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<boolean> {
  const safe = await safePathAllowingSessionPlanFile(file, allowedPaths, args);
  if (!safe.safe) return false;
  const written = ownShellWriteOf(sessionId, safe.resolved);
  if (written === undefined) return false;
  let text: string | undefined;
  try {
    text = await writtenFileText(safe.resolved, written);
  } catch {
    text = undefined;
  }
  if (text === undefined) return false;
  recordSessionRead(sessionId, safe.resolved, {
    content: text.split(/\r?\n/u).join("\n"),
    timestamp: written.mtimeMs,
    viewKind: "full",
    rawContent: text,
  });
  forgetOwnShellWrite(sessionId, safe.resolved);
  return true;
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
