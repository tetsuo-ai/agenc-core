/**
 * Source-aligned with `src/services/extractMemories/prompts.ts` at donor
 * commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC S-03 supports the single auto-memory directory, so this file keeps
 *     only the auto-only prompt variant and uses the live tool names exposed by
 *     `runtime/src/tool-registry.ts`.
 *
 * Scope boundaries:
 *   - team-memory prompt routing and shell-tool affordances.
 */

export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  "---",
  'description: "One concise sentence describing when this memory is relevant"',
  "type: user | feedback | project | reference",
  "---",
  "",
  "Write the memory body here. Prefer a short fact, followed by Why and How to apply when that context matters.",
];

const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  "## Types of memory",
  "",
  "There are four memory types:",
  "",
  "- `user`: information about the user's role, preferences, responsibilities, and background that should shape future collaboration.",
  "- `feedback`: durable guidance from the user about how to approach work, including corrections and validated non-obvious choices.",
  "- `project`: non-derivable context about current work, goals, decisions, deadlines, incidents, or constraints in this working directory.",
  "- `reference`: pointers to external systems and where current information can be found.",
  "",
];

const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  "## What not to save",
  "",
  "- Code patterns, architecture, file paths, git history, and repository structure that can be derived by reading the current project.",
  "- Anything already documented in AGENC.md files.",
  "- Debugging steps or fix recipes where the fix is already in code or commit history.",
  "- Ephemeral task state, temporary progress notes, or a summary of the current conversation.",
  "- Secrets, credentials, API keys, tokens, private keys, or sensitive personal data.",
  "",
];

function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.trim().length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing. Update an existing file rather than creating a duplicate.`
      : "";
  return [
    `You are the memory extraction subagent. Analyze only the most recent ~${newMessageCount} model-visible messages above and update persistent memory when there is durable, non-derivable information worth keeping.`,
    "",
    "Available tools: FileRead, Grep, Glob, Edit, MultiEdit, Write.",
    "All reads, searches, and writes are restricted to the memory directory. No other tools are available.",
    "",
    "You have a limited turn budget. Use FileRead in parallel for files you may update, then use Write/Edit/MultiEdit in parallel for the actual changes. Do not spend turns investigating the repository or verifying memories against source code.",
    "",
    "Only save content supported by the recent messages. If there is nothing durable to save, answer that no memory update is needed.",
    manifest,
  ].join("\n");
}

export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  omitIndexFile = false,
): string {
  const howToSave = omitIndexFile
    ? [
        "## How to save memories",
        "",
        "Write each memory to its own markdown file using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "- Organize memories by semantic topic, not chronology.",
        "- Update or delete memories that are stale or contradicted by new information.",
        "- Avoid duplicates. Prefer updating an existing relevant file.",
      ]
    : [
        "## How to save memories",
        "",
        "Saving a memory is a two-step process:",
        "",
        "1. Write the memory to its own markdown file using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "2. Add or update a pointer in MEMORY.md. MEMORY.md is an index, not a memory file. Each entry should be one concise line: `- [Title](file.md) - one-line hook`.",
        "",
        "- Keep MEMORY.md short; it is loaded into the future prompt.",
        "- Organize memories by semantic topic, not chronology.",
        "- Update or delete memories that are stale or contradicted by new information.",
        "- Avoid duplicates. Prefer updating an existing relevant file.",
      ];

  return [
    opener(newMessageCount, existingMemories),
    "",
    "If the user explicitly asks you to remember something, save it as the best matching type. If they ask you to forget something, remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    ...howToSave,
  ].join("\n");
}
