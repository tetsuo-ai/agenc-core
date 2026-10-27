import { resolve } from "node:path";
import type { CompletedToolResultRecord } from "../session/turn-state.js";

/** A deliberately small contract: one literal write, then a read of that file.
 * Unknown commands, extra requirements, partial reads and other tools keep the
 * regular gate. Neither tool output nor the final answer can grant this path.
 */
export function verifiedLiteralFile(
  task: string,
  answer: string,
  results: readonly CompletedToolResultRecord[],
  cwd: string,
): boolean {
  if (task.length > 500 || results.length !== 2) return false;
  // Match the whole request, not a complexity score or selected keywords.
  // Extra requirements keep the full review even when they sound simple.
  const contract = /^(?:Use a tool to )?(?:create|write) ([\w.-]+) (?:in the current folder )?containing (?:exactly )?(.+?)\. Then read (?:the file|it) back with a tool and reply with only (?:its|the) content\.$/i.exec(task);
  if (!contract) return false;
  const path = contract[1]!;
  const value = contract[2]!;
  if (!/^(?:["'`][^"'`\n]{1,80}["'`]|(?:[a-z]+|\d+) bytes, hexadecimal (?:[0-9a-f]{2}\s+)*[0-9a-f]{2} \(the letters [a-z]+\), with no punctuation or newline)$/i.test(value)) return false;
  const quoted = /\bcontaining\s+(?:exactly\s+)?["'`]([^"'`\n]{1,80})["'`]/i.exec(task)?.[1];
  const hex = /\bhexadecimal\s+((?:[0-9a-f]{2}\s+)*[0-9a-f]{2})(?=\s*\()/i.exec(task)?.[1];
  const expected = quoted ?? (hex === undefined ? undefined : Buffer.from(hex.replaceAll(/\s/g, ""), "hex").toString("utf8"));
  if (!expected || !/^[\x20-\x7e]{1,80}$/.test(expected) || answer.trim() !== expected) return false;
  if (hex !== undefined) {
    const countText = /^([a-z]+|\d+) bytes/i.exec(value)?.[1]?.toLowerCase();
    const smallCounts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    const count = countText === undefined ? NaN : smallCounts[countText] ?? Number(countText);
    const letters = /\(the letters ([a-z]+)\)/i.exec(value)?.[1];
    if (count !== Buffer.byteLength(expected) || letters !== expected) return false;
  }
  const [write, read] = results as readonly [CompletedToolResultRecord, CompletedToolResultRecord];
  if (results.some(result => result.isError === true || result.metadata?.exitCode === null ||
    (typeof result.metadata?.exitCode === "number" && result.metadata.exitCode !== 0))) return false;
  try {
    const w = JSON.parse(write.arguments) as Record<string, unknown>;
    const r = JSON.parse(read.arguments) as Record<string, unknown>;
    if (!/^(?:FileRead|Read)$/.test(read.toolName) || (typeof r.file_path !== "string" || resolve(cwd, r.file_path) !== resolve(cwd, path)) || r.offset !== undefined || r.limit !== undefined) return false;
    // FileRead numbers lines. The write establishes bytes; the independent
    // read establishes that the requested artifact was actually inspected.
    if (read.content !== expected && read.content.trim() !== `1→${expected}`) return false;
    if (/^(?:FileWrite|Write)$/.test(write.toolName)) return typeof w.file_path === "string" && resolve(cwd, w.file_path) === resolve(cwd, path) && w.content === expected;
    if (!/^(?:Bash|exec_command)$/.test(write.toolName) || write.metadata?.exitCode !== 0) return false;
    if ([w.cwd, w.workdir].some(dir => dir !== undefined &&
      (typeof dir !== "string" || resolve(cwd, dir) !== resolve(cwd)))) return false;
    const command = w.command ?? w.cmd;
    // Only a literal printf and an optional byte dump of the same file.
    // No shell expansion, arbitrary chaining, or format escapes.
    if (/[%'\\]/.test(expected)) return false;
    const writeCommand = `printf '${expected}' > ${path}`;
    return command === writeCommand || command === `${writeCommand} && od -An -tx1 ${path}` ||
      command === `${writeCommand} && xxd ${path}`;
  } catch {
    return false;
  }
}
