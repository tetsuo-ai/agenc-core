/**
 * File-path helpers compact uses to attach plan/project/task artifacts
 * to compaction summaries.
 *
 * Plan resolvers are wired into the AgenC plan-mode subsystem
 * (`src/planning/plan-files.ts`), which stores OpenClaude-style
 * session-scoped markdown plans under `<AGENC_HOME>/plans/<slug>.md`.
 *
 * Project-instruction discovery is implemented here so compact's prompt
 * assembly can still surface AGENC.md plus legacy AGENTS.md / CLAUDE.md /
 * .agenc/instructions.md for the cwd it was given.
 *
 * AgenC adaptation from upstream OpenClaude (`src/utils/plans.ts`):
 *
 *   - The storage root is AgenC's config dir (`AGENC_HOME` or
 *     `$HOME/.agenc`) instead of Claude's config dir.
 *   - The file content is raw markdown, matching OpenClaude's
 *     `plan_file_reference` attachment semantics.
 *
 *   - Task disk output (`getTaskOutputPath`): no gut equivalent. Gut
 *     does not own claude's `DiskTaskOutput` per-task stdout-on-disk
 *     subsystem. Compact's only caller is
 *     `createAsyncAgentAttachmentsIfNeeded`, which filters
 *     `appState.tasks` for `task.type === 'local_agent'`; gut compact
 *     wires `tasks` as an empty record today, so this resolver is
 *     never invoked with real task ids. The path returned is a
 *     deterministic gut-tree default (`<AGENC_HOME>/tasks/<id>.out`)
 *     so the resolver stays defined-everywhere; nothing in the gut
 *     writes to that path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  getPlan as readAgenCPlan,
  getPlanFilePath as resolveAgenCPlanFilePath,
} from "../../../planning/plan-files.js";

function agencHome(): string {
  return (
    process.env.AGENC_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc")
  );
}

/**
 * Read the active plan body for the current session.
 */
export function getPlan(agentId?: string, sessionId?: string): string | null {
  return readAgenCPlan({
    ...(agentId !== undefined ? { agentId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

/**
 * Resolve the plan file path for the current session.
 */
export function getPlanFilePath(agentId?: string, sessionId?: string): string {
  return resolveAgenCPlanFilePath({
    ...(agentId !== undefined ? { agentId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

/**
 * Resolve the on-disk path that *would* hold a task's output, if the
 * gut runtime owned a per-task stdout-on-disk subsystem. It does not
 * (see module-level note); the path is a deterministic
 * `<AGENC_HOME>/tasks/<taskId>.out` so the resolver is defined
 * everywhere compact references it.
 */
export function getTaskOutputPath(taskId: string): string {
  return join(agencHome(), "tasks", `${taskId}.out`);
}

const PROJECT_DOC_NAMES = [
  "AGENC.override.md",
  "AGENC.md",
  "AGENTS.override.md",
  "AGENTS.md",
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
