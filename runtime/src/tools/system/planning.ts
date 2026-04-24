import type { PermissionModeRegistry } from "../../permissions/mode.js";
import { transitionPermissionMode } from "../../permissions/mode.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import {
  formatPlanMarkdownFromSteps,
  type PlanFileContext,
} from "../../planning/plan-files.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface PlanState {
  readonly explanation?: string;
  readonly plan: readonly PlanStep[];
  readonly updatedAt: string;
}

export interface WorkflowToolController {
  readonly getPermissionModeRegistry?: () => PermissionModeRegistry | null;
  readonly getPlanFileContext?: () => PlanFileContext | null;
  readonly getPlanFilePath?: () => string;
  readonly readPlan?: () => string | null;
  readonly writePlan?: (content: string) => Promise<void>;
  readonly syncPermissionContext?: (
    nextCtx: Pick<
      ToolPermissionContext,
      "mode" | "isAutoModeAvailable" | "autoModeActive" | "bypassPermissionsAcceptedIn"
    >,
  ) => Promise<void>;
  readonly emitWarning?: (cause: string, message: string) => void;
  readonly emitPlanExited?: () => void;
  readonly emitPlanUpdated?: (state: PlanState) => void;
}

export interface PlanningToolOptions {
  readonly workflowController?: WorkflowToolController;
}

function okResult(data: unknown): ToolResult {
  return { content: safeStringify(data) };
}

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function textResult(content: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function metadata(
  name: string,
  opts: { readonly deferred?: boolean; readonly mutating?: boolean } = {},
): Tool["metadata"] {
  return {
    family: "planning",
    source: "builtin",
    preferredProfiles: ["coding", "general", "operator"],
    mutating: opts.mutating ?? true,
    hiddenByDefault: false,
    deferred: opts.deferred ?? false,
    keywords: [
      ...name.split(/[._]/).filter((part) => part.length > 0),
      "plan",
      "todo",
      "workflow",
    ],
  };
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeStatus(value: unknown): PlanStepStatus | undefined {
  if (value === "pending" || value === "in_progress" || value === "completed") {
    return value;
  }
  return undefined;
}

function parsePlanSteps(value: unknown): readonly PlanStep[] | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: "plan must be an array of { step, status } entries" };
  }
  const plan: PlanStep[] = [];
  let inProgressCount = 0;
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `plan[${index}] must be an object` };
    }
    const record = raw as Record<string, unknown>;
    const step = toOptionalString(record.step);
    const status = normalizeStatus(record.status);
    if (!step) return { error: `plan[${index}].step must be a non-empty string` };
    if (!status) {
      return {
        error:
          `plan[${index}].status must be one of pending, in_progress, completed`,
      };
    }
    if (status === "in_progress") inProgressCount += 1;
    plan.push({ step, status });
  }
  if (inProgressCount > 1) {
    return { error: "at most one plan item may be in_progress" };
  }
  return plan;
}

function parseTodoSteps(value: unknown): readonly PlanStep[] | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: "todos must be an array of { content, status } entries" };
  }
  const plan: PlanStep[] = [];
  let inProgressCount = 0;
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `todos[${index}] must be an object` };
    }
    const record = raw as Record<string, unknown>;
    const step = toOptionalString(record.content);
    const status = normalizeStatus(record.status);
    if (!step) {
      return { error: `todos[${index}].content must be a non-empty string` };
    }
    if (!status) {
      return {
        error:
          `todos[${index}].status must be one of pending, in_progress, completed`,
      };
    }
    if (status === "in_progress") inProgressCount += 1;
    plan.push({ step, status });
  }
  if (inProgressCount > 1) {
    return { error: "at most one todo may be in_progress" };
  }
  return plan;
}

async function persistStatePlan(
  controller: WorkflowToolController | undefined,
  state: PlanState,
): Promise<void> {
  if (!controller?.writePlan) return;
  await controller.writePlan(formatPlanMarkdownFromSteps(state));
}

function inputPlan(args: Record<string, unknown>): string | undefined {
  const plan = args.plan;
  return typeof plan === "string" ? plan : undefined;
}

async function updatePermissionMode(params: {
  readonly controller: WorkflowToolController | undefined;
  readonly target: "plan" | "default";
}): Promise<
  | {
      readonly fromMode: ToolPermissionContext["mode"];
      readonly toMode: ToolPermissionContext["mode"];
      readonly changed: boolean;
    }
  | { readonly error: string }
> {
  const registry = params.controller?.getPermissionModeRegistry?.() ?? null;
  if (!registry) {
    return { error: "permission mode registry is not available for workflow tools" };
  }
  const current = registry.current();
  if (params.target === "plan") {
    if (current.mode === "plan") {
      return { fromMode: "plan", toMode: "plan", changed: false };
    }
    const nextCtx = {
      ...transitionPermissionMode(current.mode, "plan", current),
      mode: "plan" as const,
    };
    await registry.update(nextCtx);
    await params.controller?.syncPermissionContext?.(nextCtx);
    params.controller?.emitWarning?.(
      "mode_changed_to_plan",
      `entered plan mode (stashed prev mode as ${current.mode})`,
    );
    return { fromMode: current.mode, toMode: "plan", changed: true };
  }

  if (current.mode !== "plan") {
    return { fromMode: current.mode, toMode: current.mode, changed: false };
  }
  const requestedTarget =
    current.prePlanMode && current.prePlanMode !== "plan"
      ? current.prePlanMode
      : "default";
  let nextCtx: ToolPermissionContext;
  try {
    nextCtx = {
      ...transitionPermissionMode("plan", requestedTarget, current),
      mode: requestedTarget,
    };
  } catch {
    nextCtx = {
      ...transitionPermissionMode("plan", "default", current),
      mode: "default",
    };
  }
  await registry.update(nextCtx);
  await params.controller?.syncPermissionContext?.(nextCtx);
  params.controller?.emitWarning?.(
    "mode_exited_plan",
    `exited plan mode (restored ${nextCtx.mode})`,
  );
  params.controller?.emitPlanExited?.();
  return { fromMode: "plan", toMode: nextCtx.mode, changed: true };
}

export function createPlanningTools(options: PlanningToolOptions = {}): readonly Tool[] {
  let state: PlanState = {
    plan: [],
    updatedAt: new Date(0).toISOString(),
  };

  const updatePlanTool: Tool = {
    name: "update_plan",
    description:
      "Update the current short execution plan. Use exactly one in_progress item while work is active; mark items completed as they finish.",
    metadata: metadata("update_plan"),
    inputSchema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    async execute(args) {
      const plan = parsePlanSteps(args.plan);
      if ("error" in plan) return errorResult(plan.error);
      state = {
        ...(toOptionalString(args.explanation)
          ? { explanation: toOptionalString(args.explanation) }
          : {}),
        plan,
        updatedAt: new Date().toISOString(),
      };
      await persistStatePlan(options.workflowController, state);
      options.workflowController?.emitPlanUpdated?.(state);
      return okResult({
        message: "Plan updated.",
        ...state,
      });
    },
  };

  const todoWriteTool: Tool = {
    name: "TodoWrite",
    description:
      "Claude-compatible todo-list alias. Prefer update_plan for new AgenC/Codex-runtime behavior; use this only when a Claude-style todo list is requested.",
    metadata: metadata("TodoWrite"),
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: { type: "string" },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(args) {
      const todos = parseTodoSteps(args.todos);
      if ("error" in todos) return errorResult(todos.error);
      state = {
        plan: todos,
        updatedAt: new Date().toISOString(),
      };
      await persistStatePlan(options.workflowController, state);
      options.workflowController?.emitPlanUpdated?.(state);
      return okResult({
        message: "Todo list updated through update_plan compatibility state.",
        ...state,
      });
    },
  };

  const enterPlanTool: Tool = {
    name: "EnterPlanMode",
    description:
      "Requests permission to enter plan mode for complex AgenC implementation tasks requiring exploration and design.",
    metadata: metadata("EnterPlanMode", { mutating: true }),
    isReadOnly: true,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await updatePermissionMode({
        controller: options.workflowController,
        target: "plan",
      });
      if ("error" in result) return errorResult(result.error);
      return textResult(
        `${result.changed ? "Entered plan mode." : "Already in plan mode."}

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and trade-offs
4. Write the plan to the AgenC plan file
5. When ready, use ExitPlanMode to present the plan for approval

Remember: DO NOT write or edit any files except the plan file.`,
        { ...result },
      );
    },
  };

  const exitPlanTool: Tool = {
    name: "ExitPlanMode",
    description:
      "Present the current AgenC plan for approval and exit plan mode when accepted.",
    metadata: metadata("ExitPlanMode", { mutating: true }),
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        allowedPrompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: ["Bash"] },
              prompt: { type: "string" },
            },
            required: ["tool", "prompt"],
            additionalProperties: false,
          },
        },
        plan: {
          type: "string",
          description:
            "Optional edited plan content supplied by an approval UI. Normally read from the AgenC plan file.",
        },
        planFilePath: {
          type: "string",
          description:
            "Optional plan path supplied by an approval UI. The runtime still uses the active AgenC plan file.",
        },
      },
      additionalProperties: true,
    },
    async execute(args) {
      const registry = options.workflowController?.getPermissionModeRegistry?.() ?? null;
      if (registry && registry.current().mode !== "plan") {
        return errorResult(
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        );
      }
      const editedPlan = inputPlan(args);
      if (editedPlan !== undefined) {
        await options.workflowController?.writePlan?.(editedPlan);
      }
      const plan = editedPlan ?? options.workflowController?.readPlan?.() ?? null;
      const filePath = options.workflowController?.getPlanFilePath?.();
      const result = await updatePermissionMode({
        controller: options.workflowController,
        target: "default",
      });
      if ("error" in result) return errorResult(result.error);
      if (!plan || plan.trim().length === 0) {
        return textResult("User has approved exiting plan mode. You can now proceed.", {
          plan: null,
          isAgent: false,
          ...(filePath !== undefined ? { filePath } : {}),
          ...result,
        });
      }
      return textResult(
        `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath ?? "(unknown)"}
You can refer back to it if needed during implementation.

## Approved Plan:
${plan}`,
        {
          plan,
          isAgent: false,
          ...(filePath !== undefined ? { filePath } : {}),
          ...(editedPlan !== undefined ? { planWasEdited: true } : {}),
          ...result,
        },
      );
    },
  };

  const workflowEnterPlanTool: Tool = {
    ...enterPlanTool,
    name: "workflow.enterPlan",
    description:
      "Compatibility alias for EnterPlanMode. Prefer EnterPlanMode for OpenClaude parity.",
    metadata: metadata("workflow.enterPlan", { deferred: true, mutating: true }),
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      additionalProperties: false,
    },
  };

  const workflowExitPlanTool: Tool = {
    ...exitPlanTool,
    name: "workflow.exitPlan",
    description:
      "Compatibility alias for ExitPlanMode. Prefer ExitPlanMode for OpenClaude parity.",
    metadata: metadata("workflow.exitPlan", { deferred: true, mutating: true }),
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      additionalProperties: false,
    },
  };

  return [
    updatePlanTool,
    todoWriteTool,
    enterPlanTool,
    exitPlanTool,
    workflowEnterPlanTool,
    workflowExitPlanTool,
  ];
}
