/**
 * Palette item suppliers.
 *
 * Two factories that produce `PaletteItem[]` for the palette popover:
 *
 *   - `getSlashCommandItems(registry)` — wraps the T11 `CommandRegistry`
 *     output. Filters internal-only entries (`userInvocable: false`) and
 *     prefixes each name with `/`.
 *   - `getMentionItems(cwd, query)` — walks `cwd` breadth-first via
 *     `fs/promises.readdir` and produces file entries for `@-mention`
 *     autocomplete. Bounded to 200 results and 4 directory levels; sorts
 *     by modification time descending so recently-touched files float to
 *     the top.
 *
 * No external globbing library is pulled in; the walk is a plain BFS over
 * `readdir({ withFileTypes: true })` with a fixed skip-list for common
 * vendor and build directories.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PaletteItem } from "./Palette.js";

/** Minimal shape of a registry entry the palette consumes. */
export interface SlashCommandLike {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly immediate?: boolean;
  readonly userInvocable?: boolean;
}

/** Minimal shape of the registry object the palette consumes. */
export interface SlashCommandRegistryLike {
  list(): ReadonlyArray<SlashCommandLike>;
}

/**
 * Produce palette items from a slash-command registry.
 *
 * Entries with `userInvocable: false` are filtered out — they're
 * internal-only commands that should never surface in the UI (this
 * matches the dispatcher's routing rule).
 */
export function getSlashCommandItems(
  registry: SlashCommandRegistryLike,
): PaletteItem[] {
  const out: PaletteItem[] = [];
  const visible = registry
    .list()
    .filter((cmd) => cmd.userInvocable !== false)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const cmd of visible) {
    const aliases = (cmd.aliases ?? []).filter(
      (alias) => typeof alias === "string" && alias.length > 0,
    );
    const descriptionParts: string[] = [];
    if (typeof cmd.description === "string" && cmd.description.length > 0) {
      descriptionParts.push(cmd.description);
    }
    if (cmd.immediate) {
      descriptionParts.push("local");
    }
    if (aliases.length > 0) {
      descriptionParts.push(aliases.map((alias) => `/${alias}`).join(" "));
    }
    out.push({
      id: cmd.name,
      label: `/${cmd.name}`,
      description: descriptionParts.join(" • "),
      keywords: [cmd.name, ...aliases],
      value: `/${cmd.name}`,
    });
  }
  return out;
}

/** Directories we never descend into during a mention walk. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".agenc",
  ".next",
  "coverage",
]);

/** Hard cap on returned entries so a large repo can't freeze the TUI. */
export const MENTION_RESULT_CAP = 200;

/** Max directory depth to descend (root == depth 0). */
export const MENTION_DEPTH_CAP = 4;

interface WalkedFile {
  readonly relativePath: string;
  readonly mtimeMs: number;
}

interface Frontier {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly depth: number;
}

/**
 * BFS the directory tree under `cwd` and collect up to `MENTION_RESULT_CAP`
 * files whose base name contains `query` (case-insensitive). Returns the
 * entries sorted by mtime descending.
 *
 * The walk stops as soon as the result cap is reached; it does not
 * pre-collect everything and then trim. That keeps the cost roughly
 * proportional to the number of matches in shallow directories.
 */
export async function getMentionItems(
  cwd: string,
  query: string,
): Promise<PaletteItem[]> {
  // Guard: non-existent or non-directory `cwd` yields an empty list. This
  // avoids an unhandled exception propagating into the React render path.
  let rootStat;
  try {
    rootStat = await fs.stat(cwd);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const qLower = query.toLowerCase();
  const results: WalkedFile[] = [];
  const queue: Frontier[] = [
    { absolutePath: cwd, relativePath: "", depth: 0 },
  ];

  while (queue.length > 0 && results.length < MENTION_RESULT_CAP) {
    const frame = queue.shift();
    if (frame === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(frame.absolutePath, {
        withFileTypes: true,
      });
    } catch {
      // Permission denied / transient error — skip this directory rather
      // than fail the whole walk.
      continue;
    }
    for (const dirent of entries) {
      if (results.length >= MENTION_RESULT_CAP) break;
      const name = dirent.name;
      const nextAbs = path.join(frame.absolutePath, name);
      const nextRel = frame.relativePath
        ? `${frame.relativePath}/${name}`
        : name;

      if (dirent.isDirectory()) {
        // Skip vendor/build directories and anything starting with a `.`
        // beyond the project root itself.
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith(".") && name !== "." && name !== "..") {
          continue;
        }
        if (frame.depth + 1 > MENTION_DEPTH_CAP) continue;
        queue.push({
          absolutePath: nextAbs,
          relativePath: nextRel,
          depth: frame.depth + 1,
        });
        continue;
      }

      if (!dirent.isFile()) continue;

      // Query filter against the base name only — paths stay hidden from
      // the filter so deeply nested files don't accidentally match via
      // their parent directory name.
      if (qLower.length > 0 && !name.toLowerCase().includes(qLower)) {
        continue;
      }

      let mtimeMs = 0;
      try {
        const st = await fs.stat(nextAbs);
        mtimeMs = st.mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      results.push({ relativePath: nextRel, mtimeMs });
    }
  }

  results.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    if (a.relativePath < b.relativePath) return -1;
    if (a.relativePath > b.relativePath) return 1;
    return 0;
  });

  return results.map((entry) => ({
    id: entry.relativePath,
    label: entry.relativePath,
    value: `@${entry.relativePath}`,
  }));
}
