/**
 * File-path helpers compact uses to attach plan/project/task artifacts
 * to compaction summaries. The gut runtime does not own openclaude's
 * plan-mode / agent-task disk artifacts, so the resolvers degrade to
 * gut-tree defaults; project-instruction discovery is implemented here
 * so compact's prompt assembly can still surface AGENTS.md / CLAUDE.md.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function agencHome(): string {
  return (
    process.env.AGENC_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc")
  );
}

export function getPlan(_agentId?: string): string | null {
  return null;
}

export function getPlanFilePath(_agentId?: string): string {
  return join(agencHome(), "plan.md");
}

export function getTaskOutputPath(taskId: string): string {
  return join(agencHome(), "tasks", `${taskId}.out`);
}

const PROJECT_DOC_NAMES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  ".agenc/instructions.md",
];

export function getProjectInstructionFilePaths(dir: string): string[] {
  const out: string[] = [];
  for (const name of PROJECT_DOC_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) out.push(p);
  }
  return out;
}
