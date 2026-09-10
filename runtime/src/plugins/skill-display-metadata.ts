import { parseYaml } from "../utils/yaml.js";

/** Display-only copy. The skill directory remains its identity and path. */
export function normalizeSkillDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length === 0 || /[\u0000-\u001f\u007f]/u.test(name)) return undefined;
  return name.slice(0, 80);
}

export function skillDisplayNameFromMarkdown(markdown: string): string | undefined {
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (header === null) return undefined;
  try {
    const fields = parseYaml(header[1] ?? "");
    return fields !== null && typeof fields === "object" && !Array.isArray(fields)
      ? normalizeSkillDisplayName((fields as Record<string, unknown>).name)
      : undefined;
  } catch {
    return undefined;
  }
}
