/**
 * Plan-mode tools: `workflow.enterPlan` and `workflow.exitPlan`.
 *
 * Mirrors the reference runtime's `EnterPlanModeTool` / `ExitPlanModeTool`
 * pair. The model uses these to explicitly enter an exploration phase
 * (reads, searches, and non-mutating bash allowed; writes, edits, and
 * other state-changing tools hidden via the advertised-bundle filter in
 * `buildAdvertisedToolBundle`) and then to hand off a proposed plan to
 * the operator for explicit approval.
 *
 * `workflow.exitPlan` does NOT itself flip the session back to
 * execution. It sets stage = "plan" (or preserves it if already there)
 * and records the proposed plan verbatim in the session workflow
 * objective so the operator sees it in `/plan status`. The operator
 * then approves by calling the existing `/plan implement` slash
 * command (or any other verb that flips stage out of "plan"), which
 * re-opens the mutating tool surface. The slash-command approval step
 * deliberately requires an explicit human act to unlock execution.
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";

export interface WorkflowPlanModeToolOptions {
  /**
   * Apply a workflow-stage change to a session. Returns the resolved
   * new stage (the caller normalizes via `updateSessionWorkflowState`,
   * so this echoes what was persisted). Must resolve even when the
   * sessionId is unknown — the caller decides how to surface that.
   */
  readonly setSessionWorkflowStage: (params: {
    readonly sessionId: string;
    readonly stage: "plan" | "implement" | "review" | "verify" | "idle";
    readonly objective?: string;
  }) => Promise<{ readonly applied: boolean; readonly reason?: string }>;
}

const SESSION_ID_ARG = "__agencSessionId";

const ENTER_PLAN_DESCRIPTION = [
  "Enter plan mode for the current session.",
  "",
  "In plan mode you MUST NOT make any changes to the project: no writeFile,",
  "no editFile, no bash commands that mutate state, no git commits, no tool",
  "that alters the filesystem, daemon state, or external services. Only use",
  "read/search tools (readFile, grep, glob, listDir, stat, symbolSearch)",
  "and informational bash commands to gather the context you need. Draft a",
  "concrete, step-by-step plan while you explore.",
  "",
  "When the plan is ready, call workflow.exitPlan with the full plan text.",
  "The operator will review it and explicitly approve before any mutating",
  "tools become available again.",
].join("\n");

const EXIT_PLAN_DESCRIPTION = [
  "Present a completed plan for operator review and leave plan mode held",
  "pending approval.",
  "",
  "Call this ONCE at the end of planning with the full plan text as the",
  "`plan` argument. After this call, the session stays in plan mode with",
  "the plan recorded as the current objective; mutating tools remain",
  "hidden until the operator explicitly approves by running `/plan",
  "implement` (or another verb that flips stage out of plan). Do not",
  "assume approval has happened just because you've called this tool —",
  "end your turn and wait for the operator's response.",
].join("\n");

function resolveSessionId(args: Record<string, unknown>): string | undefined {
  const value = args[SESSION_ID_ARG];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function jsonError(message: string): ToolResult {
  return {
    content: JSON.stringify({ error: message }),
    isError: true,
  };
}

function jsonOk(payload: Record<string, unknown>): ToolResult {
  return {
    content: JSON.stringify({ ok: true, ...payload }),
  };
}

export function createWorkflowPlanModeTools(
  options: WorkflowPlanModeToolOptions,
): Tool[] {
  const enterPlan: Tool = {
    name: "workflow.enterPlan",
    description: ENTER_PLAN_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
    },
    metadata: {
      family: "workflow",
      source: "builtin",
      // Never deferred — the model must always be able to enter plan
      // mode from any tool surface.
      hiddenByDefault: false,
      mutating: false,
    },
    async execute(args) {
      const sessionId = resolveSessionId(args);
      if (!sessionId) {
        return jsonError(
          "workflow.enterPlan requires a session context (no __agencSessionId)",
        );
      }
      const result = await options.setSessionWorkflowStage({
        sessionId,
        stage: "plan",
      });
      if (!result.applied) {
        return jsonError(
          result.reason ?? "failed to enter plan mode",
        );
      }
      return jsonOk({
        stage: "plan",
        message:
          "Plan mode active. Mutating tools (writeFile, editFile, mutating " +
          "bash, etc.) are hidden until the operator approves the plan. " +
          "Explore read-only, then call workflow.exitPlan with the full plan text.",
      });
    },
  };

  const exitPlan: Tool = {
    name: "workflow.exitPlan",
    description: EXIT_PLAN_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "The full plan text to present to the operator. Write it as a " +
            "numbered list of concrete steps with file paths and specific " +
            "changes. The operator reads this verbatim — be precise.",
        },
      },
      required: ["plan"],
    },
    metadata: {
      family: "workflow",
      source: "builtin",
      hiddenByDefault: false,
      mutating: false,
    },
    async execute(args) {
      const sessionId = resolveSessionId(args);
      if (!sessionId) {
        return jsonError(
          "workflow.exitPlan requires a session context (no __agencSessionId)",
        );
      }
      const rawPlan = typeof args.plan === "string" ? args.plan.trim() : "";
      if (rawPlan.length === 0) {
        return jsonError(
          "workflow.exitPlan requires a non-empty `plan` string",
        );
      }
      // Stay in plan stage; record the plan as the session objective so
      // the operator sees it in `/plan status` and in the TUI surface.
      // The session deliberately does NOT advance to "implement" — the
      // operator's explicit approval is required.
      const result = await options.setSessionWorkflowStage({
        sessionId,
        stage: "plan",
        objective: rawPlan,
      });
      if (!result.applied) {
        return jsonError(
          result.reason ?? "failed to record plan",
        );
      }
      return jsonOk({
        stage: "plan",
        awaitingApproval: true,
        plan: rawPlan,
        message:
          "Plan recorded. Awaiting operator approval. Mutating tools " +
          "remain hidden until the operator runs `/plan implement` (or " +
          "another command that flips workflow stage out of plan). End " +
          "your turn now — do not call further tools.",
      });
    },
  };

  return [enterPlan, exitPlan];
}
