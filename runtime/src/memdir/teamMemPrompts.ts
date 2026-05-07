import {
  buildMemoryLayerLines,
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../memory/memdir.js'
import {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../memory/types.js'
import { getAutoMemPath, getGlobalMemoryPath } from '../memory/paths.js'
import { getTeamMemPath } from './teamMemPaths.js'

/**
 * Build the combined prompt when both auto memory and team memory are enabled.
 * Closed four-type taxonomy (user / feedback / project / reference) with
 * per-type <scope> guidance embedded in XML-style <type> blocks.
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const autoDir = getAutoMemPath()
  const globalDir = getGlobalMemoryPath()
  const teamDir = getTeamMemPath()

  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        "Write each memory to its own file in the chosen global, project, or team memory directory (per the save-destination and type-scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        "**Step 1** — write the memory to its own file in the chosen global, project, or team memory directory (per the save-destination and type-scope guidance) using this frontmatter format:",
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**Step 2** — add a pointer to that file in the same directory's \`${ENTRYPOINT_NAME}\`. Each durable directory (global, project, and team) has its own \`${ENTRYPOINT_NAME}\` index — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. They have no frontmatter. Never write memory content directly into a \`${ENTRYPOINT_NAME}\`.`,
        '',
        `- Durable \`${ENTRYPOINT_NAME}\` indexes are loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep them concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  const lines = [
    '# Memory',
    '',
    `You have persistent, file-based memory directories: global memory at \`${globalDir}\`, project memory at \`${autoDir}\`, and shared team memory at \`${teamDir}\`. ${DIRS_EXIST_GUIDANCE}`,
    '',
    ...buildMemoryLayerLines(autoDir),
    '### Team memory',
    '',
    `Team memory is shared project-level memory contributed by users who work within this project directory. It is stored at \`${teamDir}\` and synced at the beginning of each session.`,
    '',
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    '## Team memory scope',
    '',
    'Team memory adds a shared scope on top of the global/project/session layers:',
    '',
    `- global user: memories about the current user as a person or collaborator. They persist across projects and are stored at \`${globalDir}\`.`,
    `- project: memories about this working directory that should not be shared through team sync. They are stored at \`${autoDir}\`.`,
    `- team: memories that are shared with and contributed by all of the users who work within this project directory. Team memories are synced at the beginning of every session and they are stored at \`${teamDir}\`.`,
    '',
    '## Where to save memories',
    '',
    `- Save user-level memories (preferences, corrections, cross-project facts) in global memory at \`${globalDir}\`. Update that directory's \`${ENTRYPOINT_NAME}\` index when you add, rename, or remove a global memory topic file.`,
    `- Save project-level memories that are useful only in this project in project memory at \`${autoDir}\`. Update that directory's \`${ENTRYPOINT_NAME}\` index when you add, rename, or remove a project memory topic file.`,
    `- Save shared team memories only when the information should be visible to every contributor in this project. Store them in team memory at \`${teamDir}\` and update that directory's \`${ENTRYPOINT_NAME}\` index.`,
    '- Do not save session-only information to durable memory unless it will matter in future conversations.',
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.',
    '',
    ...howToSave,
    '',
    '## When to access memories',
    '- When global, project, or team memories seem relevant, or the user references prior work with them or others in their organization.',
    '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
    '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
    MEMORY_DRIFT_CAVEAT,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## Memory and other forms of persistence',
    'Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.',
    '- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.',
    '- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.',
    ...(extraGuidelines ?? []),
    '',
    ...buildSearchingPastContextSection([globalDir, autoDir, teamDir]),
  ]

  return lines.join('\n')
}
