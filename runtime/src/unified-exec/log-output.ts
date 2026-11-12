import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { TruncatedText } from "./head-tail-buffer.js";

export const MAX_FULL_OUTPUT_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_LOGS = 32;

export function logOutputEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.AGENC_EXEC_OUTPUT_KEEP?.trim().toLowerCase() === "log";
}

/** The caller supplies a daemon-owned root outside the command's writable roots. */
export class FullOutputLog {
  private savedPath: string | undefined;
  private directory: string | undefined;
  private directoryIdentity: { dev: number; ino: number } | undefined;
  private failed = false;
  private closed = false;
  private fd: number | undefined;
  private identity: { dev: number; ino: number } | undefined;
  private bytes = 0;
  private capped = false;
  private referenced = false;

  constructor(root: string) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!lstatSync(root).isDirectory()) throw new Error("Log root must not be a symlink");
      // Create and open before launching the command, under protected daemon
      // state rather than its TMPDIR. Never reuse a command-planted directory.
      this.directory = mkdtempSync(join(root, "exec-output-"));
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 ||
          (process.getuid !== undefined && directory.uid !== process.getuid())) {
        throw new Error("Log directory must be private and owned by the daemon");
      }
      this.directoryIdentity = directory;
      this.savedPath = join(this.directory, "output.log");
      this.fd = openSync(this.savedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      this.identity = fstatSync(this.fd);
    } catch { this.failed = true; this.dispose(); }
  }
  get path(): string | undefined {
    if (this.failed || this.savedPath === undefined || !this.ownsDirectory()) return undefined;
    try {
      const current = lstatSync(this.savedPath);
      return current.isFile() && current.nlink === 1 && current.dev === this.identity?.dev && current.ino === this.identity?.ino
        ? this.savedPath : undefined;
    } catch { return undefined; }
  }
  get truncated(): boolean { return this.capped; }
  get isClosed(): boolean { return this.closed; }
  get wasReferenced(): boolean { return this.referenced; }
  markReferenced(): void { this.referenced = true; }
  private ownsDirectory(): boolean {
    if (this.directory === undefined) return false;
    try {
      const current = lstatSync(this.directory);
      return current.isDirectory() && current.dev === this.directoryIdentity?.dev && current.ino === this.directoryIdentity?.ino;
    } catch { return false; }
  }
  close(): void {
    this.closed = true;
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { this.failed = true; }
    this.fd = undefined;
  }
  dispose(): void {
    this.close();
    if (this.ownsDirectory()) {
      try {
        const current = this.savedPath === undefined ? undefined : lstatSync(this.savedPath);
        if (current?.isFile() && current.dev === this.identity?.dev && current.ino === this.identity?.ino) unlinkSync(this.savedPath!);
      } catch { /* Best effort; never traverse a replaced path. */ }
      try { rmdirSync(this.directory!); } catch { /* Never recursively remove foreign entries. */ }
    }
    this.savedPath = undefined;
  }
  append(chunk: string): void {
    if (this.failed || this.closed || chunk.length === 0) return;
    try {
      const bytes = Buffer.from(chunk, "utf8");
      const length = Math.min(bytes.length, MAX_FULL_OUTPUT_LOG_BYTES - this.bytes);
      let written = 0;
      while (written < length) {
        const count = writeSync(this.fd!, bytes, written, length - written);
        if (count <= 0) throw new Error("Full log write made no progress");
        written += count;
        this.bytes += count;
      }
      if (length < bytes.length) { this.capped = true; this.close(); }
    } catch { this.failed = true; this.dispose(); }
  }
}

const FAILURE = /\b(error|failed|failure|fatal|panic|exception|assertion|traceback)\b|\bTS\d{4}\b/i;

/** Resolve progress overwrites and collapse only exact repeated lines. */
function logLines(text: string): string[] {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n/g, "\n")
    .split("\n").map(line => line.split("\r").at(-1)!);
  const collapsed: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    let next = index + 1;
    while (next < lines.length && lines[next] === line) next += 1;
    collapsed.push(line);
    if (next - index > 1) collapsed.push(`[previous line repeated ${next - index - 1} times]`);
    index = next;
  }
  return collapsed;
}

function reduceLog(text: string, budget: number): TruncatedText {
  if (text.length <= budget) return { text, truncated: false, originalChars: text.length };
  const lines = logLines(text);
  const marker = `[log reduced; ${text.split("\n").length} source lines]`;
  const selected = new Set<number>();
  let remaining = Math.max(0, budget - marker.length - 2);
  // Reserve the final summary first, then failures, then the opening context.
  const priority = lines.length > 0 ? [lines.length - 1] : [];
  priority.push(...lines.flatMap((line, index) => FAILURE.test(line) ? [index] : []));
  priority.push(...[...lines.keys()].slice(-8).reverse(), ...lines.keys());
  for (const index of priority) {
    if (selected.has(index)) continue;
    const cost = lines[index]!.length + 1;
    if (cost > remaining) continue;
    selected.add(index);
    remaining -= cost;
  }
  let kept = [...selected].sort((a, b) => a - b).map(index => lines[index]!).join("\n");
  // A log without line breaks still gets useful head and tail bytes.
  if (kept.length === 0 && remaining > 1) {
    const head = Math.ceil(remaining / 2);
    kept = `${text.slice(0, head)}\n${text.slice(-(remaining - head))}`;
  }
  return { text: `${marker}\n${kept}`, truncated: true, originalChars: text.length };
}

export function reduceLogsTogether(texts: readonly string[], maxChars: number): TruncatedText[] {
  const budgets: number[] = [];
  let remaining = maxChars;
  let count = texts.length;
  for (const index of texts.map((_, index) => index).sort((a, b) => texts[a]!.length - texts[b]!.length)) {
    budgets[index] = Math.min(texts[index]!.length, Math.floor(remaining / count));
    remaining -= budgets[index]!;
    count -= 1;
  }
  return texts.map((text, index) => reduceLog(text, Math.max(64, budgets[index]!)));
}
