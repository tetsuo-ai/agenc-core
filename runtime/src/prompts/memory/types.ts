/**
 * Memory type taxonomy + frontmatter (de)serialization.
 *
 * Hand-port of openclaude `memdir/memoryTypes.ts` (270 LOC) subset:
 * keeps the four-type taxonomy, drops the long prompt strings (those
 * live in the prompt-section builders in T10-A, not here).
 *
 * The frontmatter parser is a tiny YAML subset — only simple `key: value`
 * lines between `---` fences. No nesting, no lists, no multi-line values,
 * no `js-yaml` dependency. Values are preserved as raw strings; the
 * `type` field is validated against MEMORY_TYPES.
 *
 * Memories are constrained to four types capturing context NOT derivable
 * from the current project state. Code patterns, architecture, git
 * history, and file structure are derivable (via grep/git/CLAUDE.md)
 * and should NOT be saved as memories.
 *
 * @module
 */

/** Memory type taxonomy. */
export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Parse a raw frontmatter value into a MemoryType. Invalid or missing
 * values return undefined — legacy files without a `type:` field keep
 * working, files with unknown types degrade gracefully.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== "string") return undefined;
  return MEMORY_TYPES.find((t) => t === raw);
}

/** Parsed frontmatter fields. Arbitrary keys preserved as strings. */
export interface MemoryFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly type?: MemoryType;
  /** Any additional `key: value` lines not recognized above. */
  readonly extra: Readonly<Record<string, string>>;
}

/** A fully parsed memory file: frontmatter + body text. */
export interface MemoryEntry {
  readonly filePath: string;
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
  readonly mtimeMs: number;
  readonly byteLength: number;
}

/**
 * Parse a memory file into frontmatter + body. Returns null when the
 * raw text does not begin with a `---` fence or the fence is unclosed.
 * Malformed lines inside the fence are skipped (best-effort recovery
 * — dropping the whole file on a stray line would be too brittle for
 * user-edited notes).
 */
export function parseFrontmatter(raw: string): {
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
} | null {
  if (!raw.startsWith("---")) return null;

  const lines = raw.split("\n");
  // First line is the opening fence; find the closing fence.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return null;

  const fmLines = lines.slice(1, closeIdx);
  const extra: Record<string, string> = {};
  let name: string | undefined;
  let description: string | undefined;
  let type: MemoryType | undefined;

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue; // malformed — skip
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip surrounding single/double quotes if present.
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "name":
        name = value;
        break;
      case "description":
        description = value;
        break;
      case "type":
        type = parseMemoryType(value);
        break;
      default:
        extra[key] = value;
        break;
    }
  }

  const body = lines
    .slice(closeIdx + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  return {
    frontmatter: {
      name,
      description,
      type,
      extra: Object.freeze(extra),
    },
    body,
  };
}

/**
 * Serialize a MemoryEntry back to its on-disk form. Round-trips
 * frontmatter keys in a stable order (name, description, type, then
 * extra keys alphabetically) so diffs stay clean.
 */
export function serializeMemory(entry: {
  readonly frontmatter: MemoryFrontmatter;
  readonly body: string;
}): string {
  const fm = entry.frontmatter;
  const lines: string[] = ["---"];
  if (fm.name !== undefined) lines.push(`name: ${fm.name}`);
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  if (fm.type !== undefined) lines.push(`type: ${fm.type}`);
  const extraKeys = Object.keys(fm.extra).sort();
  for (const key of extraKeys) {
    lines.push(`${key}: ${fm.extra[key]}`);
  }
  lines.push("---", "", entry.body.replace(/\n+$/, ""), "");
  return lines.join("\n");
}
