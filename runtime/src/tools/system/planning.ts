/**
 * Ports the donor `TodoWriteTool` task-checklist behavior onto AgenC's
 * planning tool surface, alongside AgenC's `EnterPlanMode` / `ExitPlanMode`
 * workflow tools.
 *
 * Donor contract pinned at 0ca43335375beec6e58711b797d5b0c4bb5019b8:
 *
 *   - Tool name:       `TodoWrite`
 *   - Schema:          `{ todos: TodoItem[] }` where each item is
 *                      `{ content, status, activeForm }` — all required.
 *   - Tool result:     literal sentence
 *                      `"Todos have been modified successfully. Ensure that
 *                       you continue to use the Follow-up list to track your
 *                       progress. Please proceed with the current tasks if
 *                       applicable"`.
 *   - Plan mode:       `TodoWrite` is metadata-only and IS permitted in
 *                      plan mode (AgenC classifier
 *                      `SAFE_YOLO_ALLOWLISTED_TOOLS`).
 *   - Transcript:      tool-call/tool-result cells are suppressed
 *                      in the donor UI. The plan panel is the sole
 *                      user-visible surface, which in AgenC is wired via the
 *                      `plan_started` / `plan_item_completed` event pair
 *                      emitted by the workflow controller.
 *
 * The runtime `update_plan` compatibility name is intentionally not shipped
 * here. `/plan` itself is an AgenC command, so the matching checklist tool is
 * `TodoWrite`. Mixing compatibility planning names with AgenC planning
 * surfaces causes duplicate-render and raw-JSON-result bugs in scrollback.
 */
import type { PermissionModeRegistry } from "../../permissions/permission-mode.js";
import { transitionPermissionMode } from "../../permissions/permission-mode.js";
import type {
  PermissionMode,
  PermissionUpdate,
  ToolPermissionContext,
} from "../../permissions/types.js";
import { applyPermissionUpdates } from "../../permissions/rules.js";
import {
  buildPlanPromptPermissionUpdates,
  consumeExitPlanModeApproval,
  parseExitPlanAllowedPrompts,
  targetPermissionModeForPlanApproval,
} from "../../planning/exit-plan-approval.js";
import type { PlanFileContext } from "../../planning/plan-files.js";
import type { Tool, ToolResult } from "../types.js";
import { plainTextErrorToolResult as errorResult } from "../results.js";
import {
  ensureTasksDir,
  getTaskListId,
  getTaskPath,
  listTasks,
  notifyTasksUpdated,
  sanitizePathComponent,
  updateTask,
  type Task,
} from "../../utils/tasks.js";
import { jsonStringify } from "../../utils/slowOperations.js";
import { writeFile } from "node:fs/promises";

type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly activeForm: string;
}

export interface PlanState {
  readonly todos: readonly TodoItem[];
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
  readonly requestContextClearAfterPlanApproval?: (
    approvedPlan: string | null,
  ) => void | Promise<void>;
}

export interface PlanningToolOptions {
  readonly workflowController?: WorkflowToolController;
}

/**
 * Donor `TodoWriteTool.mapToolResultToToolResultBlockParam` base sentence.
 */
const TODO_WRITE_RESULT_MESSAGE =
  "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";

function textResult(content: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function metadata(
  name: string,
  opts: {
    readonly deferred?: boolean;
    readonly mutating?: boolean;
    readonly virtualNoFsWrites?: boolean;
  } = {},
): Tool["metadata"] {
  return {
    family: "planning",
    source: "builtin",
    preferredProfiles: ["coding", "general", "operator"],
    mutating: opts.mutating ?? true,
    ...(opts.virtualNoFsWrites === true ? { virtualNoFsWrites: true } : {}),
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

function normalizeStatus(value: unknown): TodoStatus | undefined {
  if (value === "pending" || value === "in_progress" || value === "completed") {
    return value;
  }
  return undefined;
}

/**
 * Mirrors donor `TodoListSchema` / `TodoItemSchema` validation:
 *   - `content`     non-empty string (required)
 *   - `status`      enum `pending|in_progress|completed` (required)
 *   - `activeForm`  non-empty string (required)
 */
function parseTodoList(value: unknown): readonly TodoItem[] | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: "todos must be an array of { content, status, activeForm } entries" };
  }
  const todos: TodoItem[] = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `todos[${index}] must be an object` };
    }
    const record = raw as Record<string, unknown>;
    const content = toOptionalString(record.content);
    if (!content) {
      return { error: `todos[${index}].content cannot be empty` };
    }
    const status = normalizeStatus(record.status);
    if (!status) {
      return {
        error: `todos[${index}].status must be one of pending, in_progress, completed`,
      };
    }
    const activeForm = toOptionalString(record.activeForm);
    if (!activeForm) {
      return { error: `todos[${index}].activeForm cannot be empty` };
    }
    todos.push({ content, status, activeForm });
  }
  return todos;
}

/**
 * Bridge from the plan surface to the file-backed task board that the TUI's
 * TaskListV2 renders (useTasksV2). Todo items carry no id, so tasks are keyed
 * by a stable content slug: re-issues of the same item update the same task,
 * and items dropped from the model's rewritten list are closed out instead of
 * left dangling. Chained with sequential blocks so the board keeps the
 * model's intended order.
 */
async function persistTodosToTaskBoard(todos: readonly TodoItem[]): Promise<void> {
  try {
    const taskListId = getTaskListId();
    await ensureTasksDir(taskListId);
    const seen = new Set<string>();
    let previousId: string | null = null;
    for (const todo of todos) {
      const id = `tw-${sanitizePathComponent(todo.content).slice(0, 48).toLowerCase()}`;
      seen.add(id);
      const task: Task = {
        id,
        subject: todo.content,
        description: todo.content,
        activeForm: todo.activeForm,
        status: todo.status,
        blocks: [],
        blockedBy: previousId === null ? [] : [previousId],
        metadata: { source: "TodoWrite" },
      };
      await writeFile(getTaskPath(taskListId, id), jsonStringify(task, null, 2));
      previousId = id;
    }
    const existing = await listTasks(taskListId);
    for (const old of existing) {
      if (old.id.startsWith("tw-") && !seen.has(old.id) && old.status !== "completed") {
        await updateTask(taskListId, old.id, { status: "completed" });
      }
    }
    notifyTasksUpdated();
  } catch {
    // Best-effort bridge: plan events already landed; a board write failure
    // must not fail the TodoWrite call.
  }
}

function inputPlan(args: Record<string, unknown>): string | undefined {
  const plan = args.plan;
  return typeof plan === "string" ? plan : undefined;
}

async function updatePermissionMode(params: {
  readonly controller: WorkflowToolController | undefined;
  readonly target: "plan" | "default" | PermissionMode;
  readonly permissionUpdates?: readonly PermissionUpdate[];
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
  const requestedTarget = params.target === "default"
    ? current.prePlanMode && current.prePlanMode !== "plan"
      ? current.prePlanMode
      : "default"
    : params.target;
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
  if (params.permissionUpdates && params.permissionUpdates.length > 0) {
    nextCtx = applyPermissionUpdates(nextCtx, params.permissionUpdates);
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
    todos: [],
    updatedAt: new Date(0).toISOString(),
  };

  /**
   * Donor `TodoWriteTool` task tracking behavior.
   *
   * Description string follows donor `DESCRIPTION`.
   *
   * Tool result content is AgenC
   * `mapToolResultToToolResultBlockParam`'s `base` sentence
   * (`TodoWriteTool.ts`). When the AgenC verification-agent
   * contract is enabled, the close-out nudge below mirrors the donor:
   * finishing 3+ tasks without a verification item reminds the model
   * to spawn the verification agent before final response.
   */
  const todoWriteTool: Tool = {
    name: "TodoWrite",
    description:
      "Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. Make sure that at least one task is in_progress at all times. Always provide both content (imperative) and activeForm (present continuous) for each task.",
    metadata: metadata("TodoWrite", { virtualNoFsWrites: true }),
    recoveryCategory: "side-effecting",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list",
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
            required: ["content", "status", "activeForm"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(args) {
      const todos = parseTodoList(args.todos);
      if ("error" in todos) return errorResult(todos.error);
      const allDone = todos.length > 0 &&
        todos.every((todo) => todo.status === "completed");
      const nextTodos = allDone ? [] : todos;
      state = {
        todos: nextTodos,
        updatedAt: new Date().toISOString(),
      };
      options.workflowController?.emitPlanUpdated?.(state);
      // Bridge to the file-backed task board: the TUI's TaskListV2 reads
      // THAT store (useTasksV2), not the plan events — without this, a
      // TodoWrite only showed up as plan events and the live todo list in
      // the chat view stayed empty. Best-effort: the plan events already
      // landed, so board failures must not fail the tool call.
      await persistTodosToTaskBoard(nextTodos);
      const verificationNudgeNeeded = allDone &&
        todos.length >= 3 &&
        !todos.some((todo) => /verif/i.test(todo.content));
      const nudge = verificationNudgeNeeded
        ? '\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the sentinel agent (agent_type="sentinel"). You cannot self-assign PARTIAL by listing caveats in your summary; only the sentinel issues a verdict.'
        : "";
      return textResult(`${TODO_WRITE_RESULT_MESSAGE}${nudge}`, {
        verificationNudgeNeeded,
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
    recoveryCategory: "side-effecting",
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
    metadata: metadata("ExitPlanMode", { mutating: true, virtualNoFsWrites: true }),
    requiresApproval: true,
    recoveryCategory: "interactive",
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
      if (!registry) {
        return errorResult("permission mode registry is not available for workflow tools");
      }
      if (registry.current().mode !== "plan") {
        return errorResult(
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        );
      }
      const approval = consumeExitPlanModeApproval(args);
      const editedPlan = approval?.plan ?? inputPlan(args);
      if (editedPlan !== undefined) {
        await options.workflowController?.writePlan?.(editedPlan);
      }
      const plan = editedPlan ?? options.workflowController?.readPlan?.() ?? null;
      const filePath = options.workflowController?.getPlanFilePath?.();
      if (approval?.action === "revise") {
        const feedback = approval.feedback?.trim();
        return textResult(
          feedback && feedback.length > 0
            ? `User wants changes before approving the plan:\n\n${feedback}\n\nRemain in plan mode, revise the plan file, then call ExitPlanMode again.`
            : "User wants you to keep planning. Remain in plan mode, revise the plan file, then call ExitPlanMode again.",
          {
            planRejected: true,
            ...(feedback && feedback.length > 0 ? { feedback } : {}),
            ...(filePath !== undefined ? { filePath, planFilePath: filePath } : {}),
          },
        );
      }
      const allowedPrompts = approval?.allowedPrompts ??
        parseExitPlanAllowedPrompts(args.allowedPrompts);
      const permissionUpdates = approval?.action === "approve" &&
        approval.applyAllowedPrompts === true
        ? buildPlanPromptPermissionUpdates(allowedPrompts)
        : [];
      const targetMode = targetPermissionModeForPlanApproval(
        approval?.action === "approve" ? approval.mode : undefined,
        registry.current().prePlanMode,
      );
      const result = await updatePermissionMode({
        controller: options.workflowController,
        target: targetMode,
        permissionUpdates,
      });
      if ("error" in result) return errorResult(result.error);
      if (approval?.action === "approve" && approval.clearContext === true) {
        await options.workflowController?.requestContextClearAfterPlanApproval?.(
          plan,
        );
      }
      if (!plan || plan.trim().length === 0) {
        return textResult("User has approved exiting plan mode. You can now proceed.", {
          plan: null,
          isAgent: false,
          ...(filePath !== undefined ? { filePath, planFilePath: filePath } : {}),
          ...(permissionUpdates.length > 0
            ? { appliedPlanPermissionUpdates: permissionUpdates.length }
            : {}),
          ...(approval?.action === "approve" && approval.clearContext === true
            ? { clearContextRequested: true }
            : {}),
          ...result,
        });
      }
      const approvedPlanHeading =
        editedPlan !== undefined
          ? "Approved Plan (edited by user)"
          : "Approved Plan";
      return textResult(
        `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath ?? "(unknown)"}
You can refer back to it if needed during implementation.

## ${approvedPlanHeading}:
${plan}`,
        {
          plan,
          isAgent: false,
          ...(filePath !== undefined ? { filePath, planFilePath: filePath } : {}),
          ...(editedPlan !== undefined ? { planWasEdited: true } : {}),
          ...(permissionUpdates.length > 0
            ? { appliedPlanPermissionUpdates: permissionUpdates.length }
            : {}),
          ...(approval?.action === "approve" && approval.clearContext === true
            ? { clearContextRequested: true }
            : {}),
          ...result,
        },
      );
    },
  };

  return [todoWriteTool, enterPlanTool, exitPlanTool];
}
