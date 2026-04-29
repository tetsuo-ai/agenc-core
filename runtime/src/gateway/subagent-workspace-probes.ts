/**
 * Lightweight subagent-prompt helpers retained after the acceptance-probe
 * + workspace-state guidance stack was removed.
 *
 * What survives here:
 * - `classifyDeterministicVerificationCategories` — maps a deterministic
 *   `system.bash` / `desktop.bash` command to one or more acceptance
 *   categories (`build` / `typecheck` / `lint` / `test`), by inspecting
 *   the command tokens.
 * - `collectReachableVerificationCategories` — BFS from a planner subagent
 *   step through its downstream deterministic dependents and returns the
 *   set of acceptance categories that those deterministic steps cover.
 *   Used by the subagent prompt builder to decide whether to narrate
 *   "tests exist in downstream steps" in the child task prompt.
 * - `isNodeWorkspaceRelevant` — weighted-pattern classifier that returns
 *   `true` when step/pipeline text strongly indicates a Node/npm workspace.
 *
 * Everything else (acceptance-probe plan builder, workspace-state guidance
 * injection, package authoring inspection, stale-cmake-cache guidance) was
 * deleted together with the parent-side probe sweep in the orchestrator.
 *
 * @module
 */

import type {
  Pipeline,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
} from "../workflow/pipeline.js";
import { tokenizeShellCommand } from "../tools/system/command-line.js";
import {
  type AcceptanceProbeCategory,
  NODE_PACKAGE_TOOLING_RE,
  NODE_PACKAGE_MANIFEST_PATH_RE,
  NODE_WORKSPACE_AUTHORING_RE,
  RUST_WORKSPACE_TOOLING_RE,
} from "./subagent-orchestrator-types.js";

/* ------------------------------------------------------------------ */
/*  Deterministic command classification                               */
/* ------------------------------------------------------------------ */

function classifyDeterministicVerificationCategories(
  step: PipelinePlannerDeterministicStep,
): readonly AcceptanceProbeCategory[] {
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return [];
  }

  const args =
    typeof step.args === "object" &&
    step.args !== null &&
    !Array.isArray(step.args)
      ? (step.args as Record<string, unknown>)
      : undefined;
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const tokens =
    commandArgs.length > 0 ? [command, ...commandArgs] : tokenizeShellCommand(command);
  const normalized = tokens
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (normalized.length === 0) {
    return [];
  }

  const categories = new Set<AcceptanceProbeCategory>();
  const joined = normalized.join(" ");
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\bbuild\b/.test(joined) ||
    /\bvite\b.*\bbuild\b/.test(joined) ||
    (/\btsc\b/.test(joined) && !normalized.includes("--noemit"))
  ) {
    categories.add("build");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\btypecheck\b/.test(joined) ||
    (/\btsc\b/.test(joined) && normalized.includes("--noemit"))
  ) {
    categories.add("typecheck");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\blint\b/.test(joined) ||
    /\beslint\b/.test(joined)
  ) {
    categories.add("lint");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\btest\b/.test(joined) ||
    /\b(?:vitest|jest|pytest|mocha|ava)\b/.test(joined)
  ) {
    categories.add("test");
  }
  return [...categories];
}

export function collectReachableVerificationCategories(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): ReadonlySet<AcceptanceProbeCategory> {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0) {
    return new Set();
  }

  const dependentsByName = new Map<string, PipelinePlannerStep[]>();
  for (const plannerStep of plannerSteps) {
    for (const dependencyName of plannerStep.dependsOn ?? []) {
      const dependents = dependentsByName.get(dependencyName) ?? [];
      dependents.push(plannerStep);
      dependentsByName.set(dependencyName, dependents);
    }
  }

  const categories = new Set<AcceptanceProbeCategory>();
  const queue = [...(dependentsByName.get(step.name) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.name)) continue;
    visited.add(current.name);

    if (current.stepType === "deterministic_tool") {
      for (const category of classifyDeterministicVerificationCategories(current)) {
        categories.add(category);
      }
    }

    for (const next of dependentsByName.get(current.name) ?? []) {
      if (!visited.has(next.name)) {
        queue.push(next);
      }
    }
  }

  return categories;
}

/* ------------------------------------------------------------------ */
/*  Workspace ecosystem classification                                 */
/* ------------------------------------------------------------------ */

function scoreWorkspaceEcosystem(
  texts: readonly string[],
  patterns: readonly { pattern: RegExp; weight: number }[],
): number {
  return patterns.reduce((total, cue) => {
    const matched = texts.some((text) => cue.pattern.test(text));
    return matched ? total + cue.weight : total;
  }, 0);
}

function resolveWorkspaceEcosystem(
  texts: readonly string[],
): "node" | "rust" | "unknown" {
  const normalized = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (normalized.length === 0) {
    return "unknown";
  }

  const nodeScore = scoreWorkspaceEcosystem(normalized, [
    { pattern: NODE_PACKAGE_TOOLING_RE, weight: 4 },
    { pattern: NODE_PACKAGE_MANIFEST_PATH_RE, weight: 5 },
    { pattern: NODE_WORKSPACE_AUTHORING_RE, weight: 2 },
    { pattern: /\bworkspace:\*/i, weight: 3 },
  ]);
  const rustScore = scoreWorkspaceEcosystem(normalized, [
    { pattern: RUST_WORKSPACE_TOOLING_RE, weight: 4 },
    { pattern: /\bcargo\s+(?:build|check|run|test)\b/i, weight: 4 },
    { pattern: /\bcargo\s+.*\s--workspace\b/i, weight: 3 },
    { pattern: /(?:^|\/)(?:cargo\.toml|cargo\.lock)$/i, weight: 5 },
  ]);

  if (nodeScore > 0 && rustScore === 0) {
    return "node";
  }
  if (rustScore > 0 && nodeScore === 0) {
    return "rust";
  }
  if (nodeScore >= rustScore + 2) {
    return "node";
  }
  if (rustScore >= nodeScore + 2) {
    return "rust";
  }
  return "unknown";
}

export function isNodeWorkspaceRelevant(texts: readonly string[]): boolean {
  return resolveWorkspaceEcosystem(texts) === "node";
}
