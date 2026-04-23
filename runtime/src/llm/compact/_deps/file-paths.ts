/**
 * File-path helpers compact uses to attach plan/project/task artifacts
 * to compaction summaries.
 *
 * Plan resolvers are wired into the gut runtime's plan-mode subsystem
 * (`src/commands/plan.ts`), which stores plans as project-scoped
 * `<cwd>/.agenc/plan.json` records (`PlanRecord` shape). Compact's call
 * sites only ship `agentId`, so we resolve cwd via `process.cwd()` —
 * the gut runtime runs each session with `process.cwd()` set to the
 * session's resolved cwd (`session.ts:1518`, `session.ts:858`), which
 * matches the project root the `/plan` slash command writes against.
 *
 * Project-instruction discovery is implemented here so compact's prompt
 * assembly can still surface AGENTS.md / CLAUDE.md / .agenc/instructions.md
 * for the cwd it was given.
 *
 * Honest divergence from upstream claude (`claude/src/utils/plans.ts`):
 *
 *   - Upstream plans are session-scoped (word-slug + cache, optionally
 *     suffixed with `-agent-<id>` for subagents). Gut plans are
 *     project-scoped (`<cwd>/.agenc/plan.json`). The `agentId`
 *     parameter is therefore accepted for signature parity with
 *     compact's call sites but does NOT change the resolved path.
 *
 *   - Upstream returns the raw plan markdown read straight from disk.
 *     Gut stores plans as a JSON `PlanRecord` (`id` / `description` /
 *     `content` / `createdAt` / `updatedAt`); we return the `content`
 *     field so compact's `plan_file_reference` attachment carries the
 *     same plan body the model would see via `/plan`.
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
  getPlan as readGutPlan,
  getPlanFilePath as resolveGutPlanFilePath,
} from "../../../commands/plan.js";

function agencHome(): string {
  return (
    process.env.AGENC_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".agenc")
  );
}

function resolveCwd(): string {
  return process.cwd();
}

/**
 * Read the active plan body for the current session.
 *
 * Reads `<cwd>/.agenc/plan.json` via the gut plan-mode subsystem and
 * returns the `content` field, or `null` if no plan exists, the JSON
 * is malformed, or the `content` field is empty. The `agentId`
 * parameter is accepted for signature parity with the upstream
 * `getPlan(agentId?)` contract but is intentionally unused — gut plans
 * are project-scoped, not subagent-scoped.
 */
export function getPlan(_agentId?: string): string | null {
  const record = readGutPlan(resolveCwd());
  if (!record) return null;
  if (record.content.length === 0) return null;
  return record.content;
}

/**
 * Resolve the plan file path for the current session.
 *
 * Returns `<cwd>/.agenc/plan.json` via the gut plan-mode resolver. The
 * `agentId` parameter is accepted for signature parity but does not
 * affect the resolved path (see module-level note).
 */
export function getPlanFilePath(_agentId?: string): string {
  return resolveGutPlanFilePath(resolveCwd());
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
