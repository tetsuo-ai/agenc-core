import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TruncatedText } from "./head-tail-buffer.js";

export function logOutputEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.AGENC_EXEC_OUTPUT_KEEP?.trim().toLowerCase() === "log";
}

/** Spool before the bounded live buffer loses bytes. A failed write invalidates the reference. */
export class FullOutputLog {
  private savedPath: string | undefined;
  private failed = false;
  private closed = false;
  private fd: number | undefined;
  private identity: { dev: number; ino: number } | undefined;
  constructor(private readonly root: string) {}
  get path(): string | undefined {
    if (this.failed || this.savedPath === undefined) return undefined;
    try {
      const current = lstatSync(this.savedPath);
      return current.isFile() && current.dev === this.identity?.dev && current.ino === this.identity?.ino
        ? this.savedPath : undefined;
    } catch { return undefined; }
  }
  close(): void {
    this.closed = true;
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { this.failed = true; }
    this.fd = undefined;
  }
  append(chunk: string): void {
    if (this.failed || this.closed || chunk.length === 0) return;
    try {
      if (this.savedPath === undefined) {
        const directory = join(this.root, "exec-logs");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${randomUUID()}.log`);
        this.fd = openSync(path, "wx", 0o600);
        this.identity = fstatSync(this.fd);
        this.savedPath = path;
      }
      // Keep the opened object: replacing the visible path cannot redirect writes.
      const bytes = Buffer.from(chunk, "utf8");
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(this.fd!, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error("Full log write made no progress");
        written += count;
      }
    } catch { this.failed = true; this.close(); }
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
