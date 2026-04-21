/**
 * `EnterPlanMode` / `ExitPlanMode` tools (T11 Wave 2, Agent C).
 *
 * Port of openclaude's `EnterPlanModeTool` and `ExitPlanModeV2Tool` to the
 * AgenC `Tool` interface (`runtime/src/tools/types.ts`).
 *
 * Design notes:
 *   - The AgenC `Tool` contract takes `execute(args)` without a
 *     ToolExecutionContext, so these tools are produced by a factory
 *     (`createPlanModeTools(session)`) that closes over the session's
 *     `PermissionModeRegistry`. This mirrors the `system/coding.ts` pattern
 *     for factory-constructed tools.
 *   - Both tools carry a dedicated pre-flight `checkPermissions` helper
 *     that can be called by the gateway (wiring in W3). Unlike openclaude,
 *     where `checkPermissions` is a field on the tool, AgenC surfaces it
 *     as an exported free function so we don't extend the core `Tool`
 *     interface mid-tranche.
 *   - `ExitPlanMode` is bypass-immune: even when
 *     `isBypassPermissionsModeAvailable` is true, the exit path must still
 *     run the mode transition through the registry so `prePlanMode` is
 *     restored and `hasExitedPlanModeInSession` is set. The permission
 *     check is therefore a pure mode predicate — no bypass shortcut.
 *
 * Wiring: `session.services.permissionModeRegistry` — see
 * `getPermissionModeRegistry` in `../commands/plan.ts`. W3 lifts the
 * field into the `SessionServices` type formally.
 *
 * @module
 */

import {
  PermissionModeRegistry,
  transitionPermissionMode,
} from "../permissions/mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type { Session } from "../session/session.js";
import type { EventMsg } from "../session/event-log.js";
import type { Tool, ToolResult } from "./types.js";
import { safeStringify } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

// ─────────────────────────────────────────────────────────────────────
// Permission-check surface
// ─────────────────────────────────────────────────────────────────────

/**
 * Outcome of a pre-flight permission check. Narrow port of openclaude's
 * `PermissionDecision` — we only need allow/deny at this boundary; rule
 * attribution lives in the evaluator.
 */
export type PlanModePermissionDecision =
  | { readonly behavior: "allow"; readonly reason: string }
  | { readonly behavior: "deny"; readonly reason: string };

/**
 * `EnterPlanMode` pre-flight check: allowed only when *not* already in
 * plan mode. Mirrors the openclaude tool's check exactly.
 */
export function checkEnterPlanModePermissions(
  ctx: ToolPermissionContext,
): PlanModePermissionDecision {
  if (ctx.mode === "plan") {
    return { behavior: "deny", reason: "already_in_plan_mode" };
  }
  return { behavior: "allow", reason: "plan_mode_transition" };
}

/**
 * `ExitPlanMode` pre-flight check: allowed only when in plan mode. This
 * is "bypass-immune" — even under bypassPermissions the exit must still
 * run through the registry so prePlanMode restores and the session-level
 * exit flag flips. Concretely: we do not short-circuit on
 * `isBypassPermissionsModeAvailable` here; the only gate is
 * `ctx.mode === "plan"`.
 */
export function checkExitPlanModePermissions(
  ctx: ToolPermissionContext,
): PlanModePermissionDecision {
  if (ctx.mode !== "plan") {
    return { behavior: "deny", reason: "not_in_plan_mode" };
  }
  return { behavior: "allow", reason: "plan_mode_exit" };
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

function emitWarning(session: Session, cause: string, message: string): void {
  const msg: EventMsg = {
    type: "warning",
    payload: { cause, message },
  };
  session.emit({ id: session.nextInternalSubId(), msg });
}

function errorResult(message: string): ToolResult {
  return {
    content: safeStringify({ error: message }),
    isError: true,
  };
}

function okResult(message: string): ToolResult {
  return { content: message, isError: false };
}

export interface PlanModeTools {
  readonly enterPlanModeTool: Tool;
  readonly exitPlanModeTool: Tool;
}

/**
 * Build a pair of `EnterPlanMode` / `ExitPlanMode` tools bound to the
 * supplied session. The session must expose a
 * `services.permissionModeRegistry` (set by the W3 wiring layer); the
 * factory accepts the registry explicitly so unit tests can inject a
 * fresh registry without constructing a full session.
 */
export function createPlanModeTools(
  session: Session,
  registry: PermissionModeRegistry,
): PlanModeTools {
  const enterPlanModeTool: Tool = {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description:
      "Enter plan mode. Read-only tools only; writes, bash, and network-mutating tools are blocked until ExitPlanMode runs.",
    concurrencyClass: { kind: "exclusive" },
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Optional human-readable reason for entering plan mode (recorded in the event log).",
        },
      },
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const currentCtx = registry.current();
      const decision = checkEnterPlanModePermissions(currentCtx);
      if (decision.behavior === "deny") {
        return errorResult(`EnterPlanMode denied: ${decision.reason}`);
      }

      const reason =
        typeof args.reason === "string" && args.reason.trim().length > 0
          ? args.reason.trim()
          : undefined;
      const prevMode = currentCtx.mode;

      const nextCtx: ToolPermissionContext = {
        ...transitionPermissionMode(prevMode, "plan", currentCtx),
        mode: "plan",
      };
      await registry.update(nextCtx);

      const detail = reason
        ? `entered plan mode (prev=${prevMode}, reason=${reason})`
        : `entered plan mode (prev=${prevMode})`;
      emitWarning(session, "mode_changed_to_plan", detail);

      return okResult(
        "Entered plan mode. Focus on exploring the codebase and designing an implementation approach. " +
          "DO NOT write or edit any files yet — call ExitPlanMode when the plan is ready for approval.",
      );
    },
  };

  const exitPlanModeTool: Tool = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description:
      "Exit plan mode and restore the previous permission mode. Bypass-immune: always runs even when bypassPermissions is available.",
    concurrencyClass: { kind: "exclusive" },
    isReadOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Optional plan summary recorded in the event log on exit.",
        },
      },
      additionalProperties: false,
    },
    async execute(args): Promise<ToolResult> {
      const currentCtx = registry.current();
      const decision = checkExitPlanModePermissions(currentCtx);
      if (decision.behavior === "deny") {
        return errorResult(`ExitPlanMode denied: ${decision.reason}`);
      }

      const summary =
        typeof args.summary === "string" && args.summary.trim().length > 0
          ? args.summary.trim()
          : undefined;
      const prePlanMode = currentCtx.prePlanMode ?? "default";

      // transitionPermissionMode handles the plan-leave side effects
      // (clearing `prePlanMode`, setting `hasExitedPlanModeInSession`).
      const transitioned = transitionPermissionMode(
        "plan",
        prePlanMode,
        currentCtx,
      );
      const nextCtx: ToolPermissionContext = {
        ...transitioned,
        mode: prePlanMode,
        hasExitedPlanModeInSession: true,
      };
      await registry.update(nextCtx);

      const detail = summary
        ? `exited plan mode — restored to ${prePlanMode} (summary=${summary})`
        : `exited plan mode — restored to ${prePlanMode}`;
      emitWarning(session, "mode_exited_plan", detail);

      return okResult(`Exited plan mode. Restored to ${prePlanMode}.`);
    },
  };

  return { enterPlanModeTool, exitPlanModeTool };
}
