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
import {
  MAX_SKILL_CANDIDATE_BODY_BYTES,
  MAX_SKILL_CANDIDATES_PER_RUN,
  SKILL_CANDIDATE_BLOCK_TAG,
} from "../../skills/skill-candidates.js";

/**
 * Shared opener for the project-memory extraction prompt.
 */
function opener(
  newMessageCount: number,
  existingMemories: string,
  memoryDir?: string,
  globalMemoryDir?: string,
): string {
  const manifest =
    existingMemories.trim().length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "";
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} model-visible messages above and use them to update your persistent memory system.`,
    "",
    memoryDir === undefined
      ? "Available tools: FileRead, Grep, Glob, and Edit/MultiEdit/Write for paths inside the memory directory only. All other tools will be denied."
      : [
          "Available tools: FileRead, Grep, Glob, and Edit/MultiEdit/Write.",
          `Write to this project's memory directory only: ${memoryDir}`,
          ...(globalMemoryDir === undefined
            ? []
            : [
                `You may also READ the shared memory directory ${globalMemoryDir} — check it so you do not duplicate something already recorded there — but you cannot write to it.`,
              ]),
          "Any other path and every other tool will be denied.",
        ].join(" "),
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
  memoryDir?: string,
  globalMemoryDir?: string,
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
    opener(newMessageCount, existingMemories, memoryDir, globalMemoryDir),
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
  ].join("\n");
}

/**
 * Installed names are shown so the child does not propose a skill the user
 * already has. A shared catalog can hold well over a thousand skills, so the
 * line is capped; the parent dedupes every proposal by name regardless.
 */
const MAX_INSTALLED_SKILL_NAMES_CHARS = 4000;

function installedSkillNamesLine(names: readonly string[]): string {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return "Installed skills: none.";
  const shown: string[] = [];
  let length = 0;
  for (const name of sorted) {
    if (length + name.length + 2 > MAX_INSTALLED_SKILL_NAMES_CHARS) break;
    shown.push(name);
    length += name.length + 2;
  }
  const omitted = sorted.length - shown.length;
  return `Installed skills: ${shown.join(", ")}${omitted > 0 ? ` and ${omitted} more` : ""}.`;
}

/**
 * The one extra thing the extraction child looks for when skill candidates
 * are on: a procedure that was carried out and checked, proposed as a draft
 * skill in a fenced block at the end of its final reply. The parent parses
 * and validates that block (skills/skill-candidates.ts); the child never
 * writes a candidate itself.
 */
export function buildSkillCandidatesPromptSection(
  installedSkillNames: readonly string[],
): string {
  return [
    "## Skill candidates (drafts for the user to review)",
    "",
    "Separately from memory, look for one procedure in those messages that is worth keeping as a reusable skill. Propose it only when all of these hold:",
    "",
    "- The conversation shows the procedure being carried out and checked: at least 3 tool calls that led to an outcome that was then verified (a test run, a build, a command whose output confirmed the result).",
    "- It is likely to recur in later sessions. A one-off fix, a single command, or something derivable from the code is not a skill.",
    `- No installed skill already covers it. ${installedSkillNamesLine(installedSkillNames)}`,
    "",
    "If nothing qualifies, propose nothing; most runs propose nothing. Never write a candidate as a memory file, never invent steps that did not happen, and never include tokens, keys, passwords, or other secrets.",
    "",
    `To propose, end your final reply with one fenced block whose info string is \`${SKILL_CANDIDATE_BLOCK_TAG}\`. It holds a JSON object with a \`skillCandidates\` array of at most ${MAX_SKILL_CANDIDATES_PER_RUN} entries:`,
    "",
    "```" + SKILL_CANDIDATE_BLOCK_TAG,
    '{"skillCandidates":[{"name":"kebab-case-name","description":"one line: what the skill does","whenToUse":"one line: the situation that calls for it","body":"SKILL.md markdown with the sections Purpose, Steps, Verification, Pitfalls","evidence":["what in the conversation showed the procedure","one item per observation"]}]}',
    "```",
    "",
    `\`name\` is kebab-case and becomes the skill name. \`body\` is the SKILL.md text without frontmatter (the runtime adds it) and stays under ${MAX_SKILL_CANDIDATE_BODY_BYTES / 1024} KiB. Candidates are written as drafts under the skill-candidates directory of the AgenC home and stay inactive until the user accepts them with \`agenc skills candidates accept <name>\`.`,
  ].join("\n");
}
