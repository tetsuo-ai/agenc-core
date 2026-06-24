/**
 * Derive a compact per-turn "files changed" summary from a single assistant
 * message's tool-use blocks.
 *
 * Data source rationale: each Write/Edit/MultiEdit renders its own collapsed
 * diff card, but a build session has no concise "here's what THIS turn changed"
 * line. The cleanest scoped source for that is the assistant message's OWN
 * `tool_use` blocks — `Message.tsx` already maps over `message.message.content`,
 * so the set of file operations for the turn is right there, with no global git
 * scan and no cross-turn leakage. This reuses the SAME `buildEditDiffPreview`
 * the diff cards consume (so the file path + +N/-M counts match exactly) and the
 * SAME Write→CREATE / Edit→EDIT distinction the diff headers use.
 *
 * This module is JSX-free so it can be unit-tested without the React renderer.
 *
 * @module
 */

import { buildEditDiffPreview } from "./edit-diff-preview.js";
import { isRecord } from "../utils/record.js";

/** Tool names that mutate files and contribute to the turn summary. */
const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** One file's net change across a turn. */
export interface TurnFileChange {
  /** File path exactly as the diff cards show it (may be absolute or relative). */
  readonly file: string;
  /**
   * 'create' when the turn's FIRST op on this file was a Write (new file),
   * 'edit' otherwise. Matches the CREATE/EDIT verb on the diff cards.
   */
  readonly kind: "create" | "edit";
  /** Total additions across every op on this file this turn. */
  readonly additions: number;
  /** Total removals across every op on this file this turn. */
  readonly removals: number;
}

/** A minimal tool-use block shape (only the fields this module reads). */
interface ToolUseLike {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

/**
 * Collapse a turn's file-mutating tool uses into one entry per file, in the
 * order each file was first touched. A Write followed by an Edit on the same
 * file still reads as a 'create' (the file was born this turn); +/- counts
 * accumulate across every op. Tool uses that produce no diffable change (a
 * no-op Edit, a malformed input) contribute nothing — exactly like the diff
 * cards, which render nothing for them.
 *
 * Returns an empty array when the turn changed no files, so the caller renders
 * nothing.
 */
export function deriveTurnFileChanges(
  content: readonly unknown[] | undefined,
): readonly TurnFileChange[] {
  if (!Array.isArray(content)) return [];

  // Preserve first-touch order while merging repeat ops on the same file.
  const order: string[] = [];
  const byFile = new Map<
    string,
    { file: string; kind: "create" | "edit"; additions: number; removals: number }
  >();

  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const block = raw as ToolUseLike;
    if (block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (!FILE_EDIT_TOOLS.has(name)) continue;

    let preview: ReturnType<typeof buildEditDiffPreview>;
    try {
      preview = buildEditDiffPreview(name, block.input);
    } catch {
      // A malformed input that throws contributes nothing (the diff card also
      // renders nothing for it) — never let one bad block sink the summary.
      continue;
    }
    if (preview === null) continue;

    const file = preview.file.length > 0 ? preview.file : "file";
    // The op's intrinsic kind: a Write births a file, an Edit/MultiEdit changes
    // one. The MERGED kind keeps 'create' if ANY op this turn created the file.
    const opKind: "create" | "edit" = name === "Write" ? "create" : "edit";

    const existing = byFile.get(file);
    if (existing === undefined) {
      order.push(file);
      byFile.set(file, {
        file,
        kind: opKind,
        additions: preview.additions,
        removals: preview.removals,
      });
    } else {
      existing.additions += preview.additions;
      existing.removals += preview.removals;
      // Once created this turn, stays created (the file is new regardless of
      // later edits to it).
      if (opKind === "create") existing.kind = "create";
    }
  }

  return order.map(file => {
    const entry = byFile.get(file)!;
    return {
      file: entry.file,
      kind: entry.kind,
      additions: entry.additions,
      removals: entry.removals,
    };
  });
}
