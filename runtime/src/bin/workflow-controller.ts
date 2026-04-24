import type { EventMsg } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import {
  getPlan,
  getPlanFilePath,
  writePlan,
  type PlanFileContext,
} from "../planning/plan-files.js";
import type {
  PlanState,
  WorkflowToolController,
} from "../tools/system/planning.js";

export interface WorkflowToolControllerOptions {
  readonly getSession: () => Session | null;
  readonly agencHome?: string;
  readonly emitWarning?: (warning: { readonly cause: string; readonly message: string }) => void;
}

function statusMarker(status: string): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[-]";
  return "[ ]";
}

function renderPlanState(state: PlanState): string {
  const lines: string[] = [];
  if (state.explanation && state.explanation.trim().length > 0) {
    lines.push(state.explanation.trim(), "");
  }
  if (state.plan.length === 0) {
    lines.push("(no plan items)");
  } else {
    for (const item of state.plan) {
      lines.push(`${statusMarker(item.status)} ${item.step}`);
    }
  }
  return lines.join("\n");
}

function emit(session: Session, msg: EventMsg): void {
  session.emit({ id: session.nextInternalSubId(), msg });
}

export function buildWorkflowToolController(
  options: WorkflowToolControllerOptions,
): WorkflowToolController {
  const planFileContext = (): PlanFileContext | null => {
    const session = options.getSession();
    if (session === null) return null;
    return {
      ...(options.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
      sessionId: session.conversationId,
    };
  };

  return {
    getPermissionModeRegistry: () =>
      options.getSession()?.permissionModeRegistry ?? null,
    getPlanFileContext: planFileContext,
    getPlanFilePath: () => {
      const ctx = planFileContext();
      return getPlanFilePath(ctx ?? {});
    },
    readPlan: () => {
      const ctx = planFileContext();
      return getPlan(ctx ?? {});
    },
    writePlan: async (content) => {
      const ctx = planFileContext();
      await writePlan(ctx ?? {}, content);
    },
    syncPermissionContext: async (nextCtx) => {
      await options.getSession()?.syncPermissionContextFromRegistry(nextCtx);
    },
    emitWarning: (cause, message) => {
      options.emitWarning?.({ cause, message });
    },
    emitPlanExited: () => {
      const session = options.getSession();
      if (session === null) return;
      emit(session, {
        type: "plan_exited",
        payload: {
          turnId: "ExitPlanMode",
          timestamp: Date.now(),
        },
      });
    },
    emitPlanUpdated: (state) => {
      const session = options.getSession();
      if (session === null) return;
      const timestamp = Date.now();
      const turnId = "update_plan";
      const planItemId = "update_plan-current";
      emit(session, {
        type: "plan_started",
        payload: {
          turnId,
          planItemId,
          title: "Updated Plan",
          timestamp,
        },
      });
      emit(session, {
        type: "plan_item_completed",
        payload: {
          turnId,
          planItemId,
          finalText: renderPlanState(state),
          timestamp,
        },
      });
    },
  };
}
