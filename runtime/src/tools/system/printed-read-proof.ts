import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { MIN_TOOL_RESULT_BYTES, resolveOffloadThresholdBytes } from "../result-visibility.js";

import type { ExecCommandToolOutput } from "../../unified-exec/types.js";
import { recordSessionRead, resolveSessionId, safePathAllowingSessionPlanFile } from "./filesystem.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Largest file a read proof will snapshot. */
const READ_PROOF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One snapshot bound to the opened object: nonblocking and without following a swapped-in symlink,
 * so a path replaced by a FIFO or device after the command cannot hold the caller waiting;
 * only a bounded regular file is read.
 */
async function regularFileSnapshot(path: string) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size === 0 || stats.size > READ_PROOF_MAX_BYTES) return undefined;
    // Read at most the stat size plus one byte, so a file that grows after the stat is never read
    // past the bound; any extra byte rejects the snapshot.
    const buffer = Buffer.alloc(stats.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== stats.size) return undefined;
    return { bytes: buffer.subarray(0, filled), stats };
  } finally {
    await handle.close();
  }
}

/**
 * Current text of a workspace file from two snapshots that must agree on bytes, size, mtime, ctime,
 * inode and device, so the recorded mtime belongs to bytes that held across the window; a later
 * change shows as a newer mtime, which the gate refuses as stale.
 */
export async function stableWorkspaceText(
  path: string,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<{ readonly canonical: string; readonly text: string; readonly mtimeMs: number } | undefined> {
  const safe = await safePathAllowingSessionPlanFile(path, allowedPaths, args);
  if (!safe.safe) return undefined;
  try {
    const first = await regularFileSnapshot(safe.resolved);
    if (first === undefined) return undefined;
    const second = await regularFileSnapshot(safe.resolved);
    if (
      second === undefined || !first.bytes.equals(second.bytes) || first.bytes.length !== first.stats.size ||
      first.stats.size !== second.stats.size || first.stats.mtimeMs !== second.stats.mtimeMs ||
      first.stats.ctimeMs !== second.stats.ctimeMs || first.stats.ino !== second.stats.ino ||
      first.stats.dev !== second.stats.dev || first.bytes.includes(0)
    ) return undefined;
    // Strict decoding: distinct invalid byte sequences would otherwise compare equal as U+FFFD.
    const text = STRICT_UTF8.decode(first.bytes);
    if (text.includes("�")) return undefined;
    return { canonical: safe.resolved, text, mtimeMs: first.stats.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Shorter text could appear in output by coincidence (an echo, a test name), so it proves nothing. */
const PRINTED_READ_MIN_BYTES = 64;
const PRINTED_READ_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
/**
 * The largest model-facing exec result that reaches the model unchanged. The tool-result pipeline
 * caps or offloads a result above its effective cap (tools/execution.ts computeEffectiveMaxResultBytes),
 * which never drops below MIN_TOOL_RESULT_BYTES; exec_command declares no lower per-tool cap.
 */
export const PRINTED_READ_MAX_VISIBLE_BYTES = MIN_TOOL_RESULT_BYTES;
/** C0 controls other than tab, newline and carriage return; a later display filter may drop them. */
const PRINTED_READ_CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PRINTED_READ_GLOB = /[*?[]/u;
/** How deep below a directory the command names a file may sit, as `find dir -type f` reaches it. */
const PRINTED_READ_DIRECTORY_DEPTH = 4;
/** Outputs kept per session, and sessions kept; older ones are dropped first. */
const PRINTED_OUTPUTS_PER_SESSION = 12;
const PRINTED_OUTPUT_SESSIONS = 32;

interface PrintedOutput {
  readonly words: readonly string[];
  readonly bases: readonly string[];
  readonly shown: string;
}

/** Recent exec results per session, newest last. A Map keeps insertion order for the session bound. */
const printedOutputs = new Map<string, PrintedOutput[]>();

/**
 * The command's words outside quotes. A word with any quoted part is dropped: text a command prints
 * from a quoted argument (`printf '...; cat a.js'`) never names a file it read.
 */
function unquotedWords(cmd: string): string[] {
  const words: string[] = [];
  let word = "";
  let tainted = false;
  const end = (): void => {
    if (word.length > 0 && !tainted && word.length <= 1024) words.push(word);
    word = "";
    tainted = false;
  };
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") {
      const close = cmd.indexOf(ch, i + 1);
      if (close < 0) return words;
      tainted = true;
      i = close;
    } else if (ch === "\\") {
      tainted = true;
      i += 1;
    } else if (/[\s;&|()<>]/u.test(ch)) {
      end();
    } else {
      word += ch;
    }
  }
  end();
  return words;
}

/** Whether `needle` occurs in `haystack` starting at the start of a line. */
function includesAtLineStart(haystack: string, needle: string): boolean {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (at === 0 || haystack[at - 1] === "\n") return true;
  }
  return false;
}

/** `cat -n` rendering of a whole file: six-column right-aligned number, a tab, the line. */
function catNumbered(text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${String(index + 1).padStart(6, " ")}\t${line}`).join("\n");
}

function globSegmentPattern(segment: string): RegExp | undefined {
  let source = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === "*") {
      source += "[^/]*";
      while (segment[i + 1] === "*") i += 1;
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const close = segment.indexOf("]", i + 2);
      if (close < 0) return undefined;
      const body = segment.slice(i + 1, close).replace(/^!/u, "^").replace(/\\/gu, "\\\\");
      source += `[${body}]`;
      i = close;
    } else {
      source += ch.replace(/[.+^${}()|\\]/gu, "\\$&");
    }
  }
  try {
    return new RegExp(`^${source}$`, "u");
  } catch {
    return undefined;
  }
}

/** Whether a glob word matches `file` the way sh expands it without globstar (`**` acts as `*`). */
function globMatches(word: string, base: string, file: string): boolean {
  const pattern = (isAbsolute(word) ? word : `${base}/${word}`).split("/").filter((s) => s.length > 0 && s !== ".");
  const target = file.split(sep).filter((s) => s.length > 0);
  if (pattern.includes("..") || pattern.length !== target.length) return false;
  return pattern.every((segment, index) => {
    const name = target[index]!;
    if (!PRINTED_READ_GLOB.test(segment)) return segment === name;
    // sh leaves hidden names to patterns that start with a dot.
    if (name.startsWith(".") && !segment.startsWith(".")) return false;
    return globSegmentPattern(segment)?.test(name) === true;
  });
}

/** Path segments of `file` below `dir`, or undefined when it is not below it. */
function segmentsBelow(dir: string, file: string): string[] | undefined {
  const tail = relative(dir, file);
  if (tail === "" || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) return undefined;
  return tail.split(sep);
}

/**
 * Whether the command can have printed `file`: a word names it, a glob word matches it, or a word
 * names a directory above it (at most four levels, through no hidden or node_modules directory)
 * and the output names the file, as the header a printing loop writes before each one.
 */
function namesFile(entry: PrintedOutput, file: string): boolean {
  for (const word of entry.words) {
    for (const base of isAbsolute(word) ? [entry.bases[0]!] : entry.bases) {
      if (PRINTED_READ_GLOB.test(word)) {
        if (globMatches(word, base, file)) return true;
        continue;
      }
      const path = resolve(base, word);
      if (path === file) return true;
      const below = segmentsBelow(path, file);
      if (below === undefined || below.length > PRINTED_READ_DIRECTORY_DEPTH) continue;
      if (below.slice(0, -1).some((segment) => segment.startsWith(".") || segment === "node_modules")) continue;
      if (below.at(-1)!.startsWith(".")) continue;
      if (entry.shown.includes(file) || entry.shown.includes(basename(file)) ||
          entry.bases.some((b) => entry.shown.includes(relative(b, file)))) return true;
    }
  }
  return false;
}

/** Whether the entire result can reach the model without an exec cut or a later cap/offload. */
export function isCompletePrintedOutput(output: ExecCommandToolOutput, visible: string): boolean {
  return output.exitCode !== null && !output.truncated && !output.timedOut &&
    output.session_id === undefined && output.process_id === undefined && output.detached !== true &&
    output.command_outcome === undefined && output.stdout.length > 0 &&
    visible.length <= PRINTED_READ_MAX_OUTPUT_CHARS && !PRINTED_READ_CONTROL.test(visible) &&
    Buffer.byteLength(visible, "utf8") <= Math.min(
      PRINTED_READ_MAX_VISIBLE_BYTES, resolveOffloadThresholdBytes() ?? PRINTED_READ_MAX_VISIBLE_BYTES,
    );
}

/**
 * Sessions keep the text of recent exec_command results, so an Edit or Write of a file the
 * model saw only through the shell (`cat`, a `for` loop over a glob or over `find`, a `cd` chain,
 * `cat -n`) can count that file as read; without this, the first edit was refused and the model paid
 * a FileRead round trip and a resent edit. Only a shell that exited on its own, untruncated, with no
 * live session and a model-visible result of at most {@link PRINTED_READ_MAX_VISIBLE_BYTES} bytes is
 * kept. Nothing is read here: the proof runs when an edit asks for it ({@link provePrintedRead}), so
 * commands pay only for keeping the text. Light also keeps literal-read support for short files.
 */
export function rememberPrintedOutput(params: {
  readonly cmd: string;
  readonly output: ExecCommandToolOutput;
  /** The exact text exec_command returns to the model for this call. */
  readonly visible: string;
  readonly cwd: string;
  readonly args: Record<string, unknown>;
}): void {
  const { output, visible } = params;
  // A head-and-tail cut (max_output_tokens, explicit or default) sets truncated; a later cap or offload
  // never touches a result this small. Either way the model would not see a whole file.
  if (!isCompletePrintedOutput(output, visible)) return;
  const sessionId = resolveSessionId(params.args);
  if (sessionId === undefined) return;
  const words = unquotedWords(params.cmd)
    .filter((word) => !word.startsWith("-") && !word.includes("$") && !word.includes("="));
  const bases = [resolve(params.cwd)];
  const all = unquotedWords(params.cmd);
  all.forEach((word, index) => {
    const target = all[index + 1];
    if (word === "cd" && target !== undefined && !target.includes("$") && !PRINTED_READ_GLOB.test(target)) {
      const dir = resolve(params.cwd, target);
      if (!bases.includes(dir)) bases.push(dir);
    }
  });
  if (words.length === 0) return;
  const list = printedOutputs.get(sessionId) ?? [];
  printedOutputs.delete(sessionId);
  list.push({ words, bases, shown: visible.replace(/\r\n/gu, "\n") });
  if (list.length > PRINTED_OUTPUTS_PER_SESSION) list.splice(0, list.length - PRINTED_OUTPUTS_PER_SESSION);
  printedOutputs.set(sessionId, list);
  if (printedOutputs.size > PRINTED_OUTPUT_SESSIONS) printedOutputs.delete(printedOutputs.keys().next().value!);
}

/**
 * Whether a kept command of the session could have printed `file`. Path checks only, no file access:
 * the read-before-write preflight uses it to leave the decision to the edit's own check.
 */
export function mayProvePrintedRead(sessionId: string, file: string): boolean {
  const list = printedOutputs.get(sessionId);
  return list !== undefined && list.some((entry) => namesFile(entry, file));
}

/**
 * Counts `file` as fully read when a kept exec result of the session shows its exact current text,
 * raw or as `cat -n` prints it, from the start of a line, and the command names the file (see
 * {@link namesFile}). The model has then seen the current text, which is what the read-before-write
 * gate asks for. A file shorter than 64 bytes never counts, since its text can appear by coincidence;
 * snapshots and their bounds are the ones Light's proof uses. Returns whether the read was recorded.
 */
export async function provePrintedRead(
  sessionId: string,
  file: string,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<boolean> {
  const list = printedOutputs.get(sessionId);
  if (list === undefined) return false;
  const named = list.filter((entry) => namesFile(entry, file));
  if (named.length === 0) return false;
  const snapshot = await stableWorkspaceText(file, allowedPaths, args);
  if (snapshot === undefined || Buffer.byteLength(snapshot.text.trim(), "utf8") < PRINTED_READ_MIN_BYTES) return false;
  if (PRINTED_READ_CONTROL.test(snapshot.text)) return false;
  const text = snapshot.text.replace(/\r\n/gu, "\n");
  const numbered = catNumbered(text);
  for (const entry of named.reverse()) {
    if (!includesAtLineStart(entry.shown, text) && !includesAtLineStart(entry.shown, numbered)) continue;
    recordSessionRead(sessionId, snapshot.canonical, {
      content: snapshot.text.split(/\r?\n/u).join("\n"),
      timestamp: snapshot.mtimeMs,
      viewKind: "full",
      rawContent: snapshot.text,
    });
    return true;
  }
  return false;
}

/** Test hook: forget every kept exec result. */
export function resetPrintedOutputsForTest(): void {
  printedOutputs.clear();
}
