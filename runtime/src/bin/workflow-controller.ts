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
      // Use the live turn id from the active turn — NOT the tool name.
      // Earlier code hardcoded `turnId: "ExitPlanMode"`, which leaked
      // the tool name into `events-to-messages.ts:ensureTurnId`'s
      // mutating side effect (`currentTurnId = turnId`), contaminating
      // every subsequent assistant row in the same turn with the bogus
      // turn id "ExitPlanMode" — causing each filtered "Calling tool."
      // lifecycle group to fail the per-turn coalesce check and
      // produce a stray `● .` row in the transcript.
      // Mirrors the canonical emitPlanExited at session/plan-mode.ts:442
      // which uses `resolveTurnId(ctx)`.
      const activeTurnId =
        (session as unknown as {
          activeTurn?: { unsafePeek?: () => { turnId?: string } | null };
          conversationId?: string;
        }).activeTurn?.unsafePeek?.()?.turnId;
      const sessionId = (session as unknown as { conversationId?: string })
        .conversationId;
      // turnId is a required field on the event payload. Prefer the
      // active turn id (real conversation turn); fall back to the
      // session's conversationId so downstream reducers always see a
      // stable, non-empty value. NEVER use a tool-name string here.
      const turnId =
        typeof activeTurnId === "string" && activeTurnId.length > 0
          ? activeTurnId
          : typeof sessionId === "string" && sessionId.length > 0
            ? sessionId
            : "plan-exited";
      emit(session, {
        type: "plan_exited",
        payload: {
          turnId,
          timestamp: Date.now(),
        },
      });
    },
    emitPlanUpdated: (state) => {
      const session = options.getSession();
      if (session === null) return;
      const timestamp = Date.now();
      // Same fix as emitPlanExited above — use the active turn id, not
      // the hardcoded tool-name string "update_plan".
      const activeTurnId =
        (session as unknown as {
          activeTurn?: { unsafePeek?: () => { turnId?: string } | null };
          conversationId?: string;
        }).activeTurn?.unsafePeek?.()?.turnId;
      const sessionId = (session as unknown as { conversationId?: string })
        .conversationId;
      const turnId =
        typeof activeTurnId === "string" && activeTurnId.length > 0
          ? activeTurnId
          : typeof sessionId === "string" && sessionId.length > 0
            ? sessionId
            : "update-plan";
      const planItemId = `update_plan-${turnId}`;
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
