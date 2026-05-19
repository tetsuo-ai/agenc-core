/**
 * Source-aligned with `src/services/extractMemories/prompts.ts` at source
 * commit 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC memory extraction currently writes through one project memory
 *     root, so this file carries the auto-only extraction prompt variant.
 *   - Tool names match the live AgenC child policy in extractMemories.ts.
 *
 * Scope boundaries:
 *   - combined team-memory extraction routing.
 */

import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from "../../memdir/memory-types.js";

/**
 * Shared opener for the project-memory extraction prompt.
 */
function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.trim().length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "";
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} model-visible messages above and use them to update your persistent memory system.`,
    "",
    "Available tools: FileRead, Grep, Glob, and Edit/MultiEdit/Write for paths inside the memory directory only. All other tools will be denied.",
    "",
    "You have a limited turn budget. Edit requires a prior FileRead of the same file, so the efficient strategy is: turn 1 — issue all FileRead calls in parallel for every file you might update; turn 2 — issue all Write/Edit/MultiEdit calls in parallel. Do not interleave reads and writes across multiple turns.",
    "",
    `You MUST only use content from the last ~${newMessageCount} model-visible messages to update persistent memory. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
      manifest,
  ].join("\n");
}

/**
 * Build the extraction prompt for project auto-memory.
 * Four-type taxonomy, no scope guidance because the child can write only to
 * the configured memory directory.
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  omitIndexFile = false,
): string {
  const howToSave = omitIndexFile
    ? [
        "## How to save memories",
        "",
        "Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "- Organize memory semantically by topic, not chronologically.",
        "- Update or remove memories that turn out to be wrong or outdated.",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ]
    : [
        "## How to save memories",
        "",
        "Saving a memory is a two-step process:",
        "",
        "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.",
        "",
        "- `MEMORY.md` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise.",
        "- Organize memory semantically by topic, not chronologically.",
        "- Update or remove memories that turn out to be wrong or outdated.",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ];

  return [
    opener(newMessageCount, existingMemories),
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
  ].join("\n");
}
