import { diffLines } from "diff";

/** Show the resulting boundaries, including untouched neighbors, without a reread. */
export function lightEditPreview(before: string, after: string): string {
  if (before.length + after.length > 2_000_000) {
    return "\nPreview omitted for a large file; inspect the changed region with FileRead.";
  }
  const changes = diffLines(before, after, { timeout: 20, maxEditLength: 2000 });
  if (!changes) return "\nPreview unavailable; inspect the changed region with FileRead.";
  const lines = after.split("\n");
  const selected = new Set<number>();
  let line = 0;
  const add = (start: number, end: number) => {
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) selected.add(i);
  };
  for (const part of changes) {
    const count = part.count ?? 0;
    if (part.added || part.removed) {
      add(line - 2, line + 5);
      if (part.added) add(line + count - 5, line + count + 3);
    }
    if (!part.removed) line += count;
  }
  const ordered = [...selected].sort((a, b) => a - b);
  const out = ["\nEdited region (line numbers are not file content):"];
  let size = out[0]!.length;
  let previous = -1;
  for (const i of ordered) {
    const value = `${i + 1}: ${lines[i]}`;
    if (size + value.length > 2400 || out.length >= 45) {
      out.push("[Preview bounded; use FileRead for remaining regions.]");
      break;
    }
    if (previous >= 0 && i > previous + 1) out.push("...");
    out.push(value);
    size += value.length + 1;
    previous = i;
  }
  return out.join("\n");
}
