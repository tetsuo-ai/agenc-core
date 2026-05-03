/**
 * Shared primitives for the model-facing Task* tool family.
 *
 * Shape differences from the donor tools:
 *   - AgenC model-facing tools implement the local Tool contract directly
 *     instead of the donor buildTool wrapper.
 *   - Execution-only injected args are tolerated by strict validation.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Donor teammate hook and mailbox integrations are outside the current
 *     AgenC task-board surface.
 */

import type { Tool, ToolResult } from "../types.js";
import { SESSION_ID_ARG } from "../system/filesystem.js";
import { sharedServer } from "../concurrency.js";

export interface TaskToolOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly getSession: () => unknown | null;
}

export const TASK_CONCURRENCY = sharedServer("agenc-tasks");

export function toolMetadata(
  family: string,
  opts: {
    readonly mutating?: boolean;
    readonly deferred?: boolean;
    readonly hiddenByDefault?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family,
    source: "builtin",
    hiddenByDefault: opts.hiddenByDefault ?? false,
    mutating: opts.mutating ?? false,
    deferred: opts.deferred ?? false,
    keywords: opts.keywords ?? [family],
    preferredProfiles: ["coding", "operator", "general"],
  };
}

export function taskTextResult(
  content: string,
  codeModeResult?: unknown,
  isError?: boolean,
): ToolResult {
  return {
    content,
    ...(isError ? { isError: true } : {}),
    ...(codeModeResult !== undefined ? { codeModeResult } : {}),
  };
}

export function taskStrictArgs(
  args: Record<string, unknown>,
  opts: {
    readonly allowed: ReadonlySet<string>;
    readonly required?: ReadonlyArray<string>;
  },
): ToolResult | null {
  const allowed = new Set<string>([
    ...opts.allowed,
    "__callId",
    SESSION_ID_ARG,
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return taskTextResult(
        `unknown field \`${key}\``,
        { error: `unknown field \`${key}\`` },
        true,
      );
    }
  }
  for (const key of opts.required ?? []) {
    if (typeof args[key] !== "string" || args[key].trim().length === 0) {
      return taskTextResult(
        `${key} is required`,
        { error: `${key} is required` },
        true,
      );
    }
  }
  return null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
