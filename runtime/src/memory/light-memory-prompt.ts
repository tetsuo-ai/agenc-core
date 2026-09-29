/** Light presentation of the canonical memory contract. Paths remain session-scoped. */
export function lightMemoryInstructions(types: readonly string[], indexLines: number): string {
  return [
    "# auto memory",
    "Use global memory for user facts across projects, project memory for this repository. Save requested memories immediately; forget by deleting the file and index entry. Save user preferences, confirmed feedback, non-code project context and external references. Do not save repository-derived facts, code patterns, architecture, paths, git history, fix recipes, AGENC.md duplicates or current task state. For activity logs or PR lists, ask what was surprising or non-obvious and save that.",
    `Keep one fact per <topic>.md, with YAML frontmatter name, description (specific relevance hook), and type (${types.join(" | ")}). Feedback/project facts need **Why:** and **How to apply:**. Check for existing topic files first; update or remove duplicates.`,
    `Index each file in MEMORY.md: - [Title](topic.md): relevance hook. No frontmatter; one line per file, under 150 characters. Only the first ${indexLines} lines load. Both indexes are in context; relevant memories may also be attached. Read relevant files. When asked to check, recall or remember, check memory; search with Grep or grep.`,
    "Memory is a past claim: verify named files, functions and flags against current evidence and fix or delete stale entries. If told to ignore memory, treat indexes as empty and do not mention their contents.",
  ].join("\n");
}

export function lightMemoryDirectories(project: string, global: string, extra?: readonly string[]): string {
  return [
    "# Memory directories",
    `Global (cross-project): \`${global}\``,
    `Project (shared by worktrees): \`${project}\``,
    "Directories exist. Write directly; no mkdir or existence checks. Keep session-only state in conversation, plans or tasks.",
    ...(extra ?? []),
  ].join("\n");
}
