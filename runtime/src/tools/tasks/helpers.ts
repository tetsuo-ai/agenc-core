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
import { validationErrorToolResult } from "../results.js";
import { strictArgsRefusal } from "../strict-args.js";
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
    readonly virtualNoFsWrites?: boolean;
  } = {},
): Tool["metadata"] {
  return {
    family,
    source: "builtin",
    hiddenByDefault: opts.hiddenByDefault ?? false,
    mutating: opts.mutating ?? false,
    ...(opts.virtualNoFsWrites === true ? { virtualNoFsWrites: true } : {}),
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

/**
 * A refusal made before the tool touched anything. Without the disposition a
 * bare error from a mutating Task* tool is filed as an unknown outcome and
 * gates the whole session behind /resolve (#2190).
 */
export function taskValidationResult(
  content: string,
  codeModeResult?: unknown,
): ToolResult {
  return {
    ...validationErrorToolResult("tool:tasks:validation", content),
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
  return strictArgsRefusal(
    args,
    { ...opts, injected: ["__callId", SESSION_ID_ARG] },
    (message) => taskValidationResult(message, { error: message }),
  );
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
