import {
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  transitionPermissionMode,
} from "./permission-mode.js";
import {
  applyRulePermissionUpdate,
} from "./rules.js";
import { serializeRuleValue } from "./rules.js";
import { validateCanonicalSessionPermissionRuleBuckets } from "./session-rule-buckets.js";
import type {
  PermissionBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
  ToolPermissionContext,
} from "./types.js";
import {
  immutableToolPermissionContext,
  PERMISSION_BEHAVIORS,
} from "./types.js";

/** A rule mutation that was rejected before registry publication began. */
export class PermissionRuleMutationPrecommitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermissionRuleMutationPrecommitError";
  }
}

/** Apply external permission updates through the canonical mode FSM. */
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  if (update.type !== "setMode") {
    return applyRulePermissionUpdate(context, update);
  }
  if (update.mode === "bypassPermissions") {
    throw new Error(
      "PermissionUpdate cannot enable bypassPermissions; use the exact-cwd consent transition",
    );
  }
  const transitioned = transitionPermissionMode(
    context.mode,
    update.mode,
    context,
  );
  return immutableToolPermissionContext({
    ...transitioned,
    mode: update.mode,
  });
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: readonly PermissionUpdate[],
): ToolPermissionContext {
  let next = context;
  for (const update of updates) {
    next = applyPermissionUpdate(next, update);
  }
  return next;
}

/**
 * Replace one source's complete logical allow/deny/ask buckets without
 * leaking auto-mode's stripped-rule storage into the projection. Both the
 * daemon authority and its TUI mirror use this exact transformation.
 */
export function replacePermissionRuleSourceBuckets(
  context: ToolPermissionContext,
  destination: PermissionUpdateDestination,
  buckets: Readonly<Record<PermissionBehavior, readonly PermissionRuleValue[]>>,
): ToolPermissionContext {
  const autoActive =
    context.mode === "auto" ||
    (context.mode === "plan" && context.autoModeActive === true);
  let next = restoreDangerousPermissions(context);
  for (const behavior of PERMISSION_BEHAVIORS) {
    next = applyPermissionUpdate(next, {
      type: "replaceRules",
      destination,
      behavior,
      rules: buckets[behavior],
    });
  }
  if (!autoActive) return next;
  return immutableToolPermissionContext({
    ...stripDangerousPermissionsForAutoMode(next),
    autoModeActive: true,
  });
}

export interface PermissionRuleSourceMutationResult {
  readonly next: ToolPermissionContext;
  readonly applied: boolean;
  readonly buckets: Readonly<
    Record<PermissionBehavior, readonly string[]>
  >;
}

/** Mutate one rule against the latest registry-owned source snapshot. */
export function mutatePermissionRuleSource(
  context: ToolPermissionContext,
  destination: PermissionUpdateDestination,
  operation: "add" | "remove",
  behavior: PermissionBehavior,
  rule: PermissionRuleValue,
): PermissionRuleSourceMutationResult {
  const logical = restoreDangerousPermissions(context);
  const current = validateCanonicalSessionPermissionRuleBuckets(
    {
      allow: logical.alwaysAllowRules[destination] ?? [],
      deny: logical.alwaysDenyRules[destination] ?? [],
      ask: logical.alwaysAskRules[destination] ?? [],
    },
    `existing ${destination} permission rules`,
  );
  const serializedRule = serializeRuleValue(rule);
  const existing = current.serialized[behavior];
  const alreadyPresent = existing.includes(serializedRule);
  const nextBucket =
    operation === "add"
      ? alreadyPresent
        ? existing
        : [...existing, serializedRule]
      : existing.filter((candidate) => candidate !== serializedRule);
  const applied =
    operation === "add"
      ? !alreadyPresent
      : nextBucket.length !== existing.length;
  if (!applied) {
    return Object.freeze({
      next: context,
      applied: false,
      buckets: current.serialized,
    });
  }
  const candidate = validateCanonicalSessionPermissionRuleBuckets(
    {
      ...current.serialized,
      [behavior]: nextBucket,
    },
    `updated ${destination} permission rules`,
  );
  return Object.freeze({
    next: replacePermissionRuleSourceBuckets(
      context,
      destination,
      candidate.parsed,
    ),
    applied: true,
    buckets: candidate.serialized,
  });
}
