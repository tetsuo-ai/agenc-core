/**
 * `/plan` — enter plan mode or display the active plan.
 *
 * Port of agenc `src/commands/plan/plan.tsx` adapted to AgenC's
 * `SlashCommand` contract (`runtime/src/commands/types.ts`).
 *
 * Behaviour matrix:
 *
 *   Current mode ≠ "plan":
 *     - Transition the `PermissionModeRegistry` to `plan` via
 *       `transitionPermissionMode` (which stashes `prePlanMode` through
 *       `prepareContextForPlanMode`).
 *     - Emit a `warning` event with cause `mode_changed_to_plan` so
 *       sidecars/TUI see the transition.
 *     - If `argsRaw` is a non-empty description (and not the literal
 *       `open`), forward it as a fresh user prompt so the model can
 *       begin plan-mode reasoning with the description as context.
 *     - Otherwise return a `text` confirmation.
 *
 *   Current mode === "plan":
 *     - `/plan open` opens the plan file in `$EDITOR` / `$VISUAL` via
 *       `child_process.spawn`. Falls back to returning the path so the
 *       user can open it manually.
 *     - `/plan` with no args renders the current plan (or a hint that no
 *       plan is written yet).
 *
 * Plan storage path decision: match AgenC's session plan files, but
 * translate the storage root to AgenC: `<AGENC_HOME>/plans/<slug>.md`.
 *
 * Dependency: expects `session.services.permissionModeRegistry`.
 *
 * @module
 */

import { spawn } from "node:child_process";

import {
  PermissionModeRegistry,
  transitionPermissionMode,
} from "../permissions/permission-mode.js";
import type { PermissionMode } from "../permissions/types.js";
import {
  formatPlanText,
  clearAllPlanSlugs,
  getPlan,
  getPlanFilePath,
  setPlanSlug,
  writePlan,
  type PlanFileContext,
} from "../planning/plan-files.js";
import type { Session } from "../session/session.js";
import type { EventMsg } from "../session/event-log.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  createPlanDashboardSnapshot,
  openPlanDashboard,
} from "./plan-menu.js";

export {
  clearAllPlanSlugs,
  formatPlanText,
  getPlan,
  getPlanFilePath,
  setPlanSlug,
  writePlan,
};

/**
 * Best-effort `$EDITOR` launch. Detaches so we don't block the command
 * pipeline. Returns `{ error }` when no editor env is set or the spawn
 * fails immediately.
 */
export async function openInEditor(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly ok: true } | { readonly error: string }> {
  const editor = env.VISUAL ?? env.EDITOR;
  if (!editor || editor.trim().length === 0) {
    return { error: "no $EDITOR or $VISUAL configured" };
  }
  return await new Promise((resolvePromise) => {
    try {
      const child = spawn(editor, [path], {
        stdio: "inherit",
        detached: false,
      });
      child.once("error", (err) => {
        resolvePromise({ error: err.message });
      });
      child.once("spawn", () => {
        resolvePromise({ ok: true });
      });
    } catch (err) {
      resolvePromise({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Permission-mode registry accessor
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the session's permission-mode registry.
 */
export function getPermissionModeRegistry(
  session: Session,
): PermissionModeRegistry | null {
  const svc = session.services as unknown as Record<string, unknown>;
  const candidate = svc.permissionModeRegistry;
  if (candidate instanceof PermissionModeRegistry) return candidate;
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the daemon-backed `session.setPermissionMode` forwarder when the
 * TUI runs against the daemon. The bridge session declares
 * `setDaemonPermissionMode` (tui/daemon-session.ts); the in-process Session
 * does not, so its absence means the local registry is authoritative.
 */
function daemonPermissionModeFn(
  ctx: SlashCommandContext,
): ((mode: string) => Promise<unknown>) | null {
  const fn = (ctx.session as unknown as {
    setDaemonPermissionMode?: (mode: string) => Promise<unknown>;
  }).setDaemonPermissionMode;
  return typeof fn === "function" ? fn.bind(ctx.session) : null;
}

function emitWarning(session: Session, cause: string, message: string): void {
  const msg: EventMsg = {
    type: "warning",
    payload: { cause, message },
  };
  session.emit({ id: session.nextInternalSubId(), msg });
}

function planFileContext(ctx: SlashCommandContext): PlanFileContext {
  return {
    ...(ctx.agencHome !== undefined ? { agencHome: ctx.agencHome } : {}),
    home: ctx.home,
    sessionId: ctx.session.conversationId,
  };
}

function maybeOpenPlanDashboard(
  ctx: SlashCommandContext,
  params: {
    readonly mode: "plan";
    readonly previousMode?: PermissionMode;
    readonly planText: string | null;
  },
): boolean {
  const fileCtx = planFileContext(ctx);
  return openPlanDashboard(
    ctx,
    createPlanDashboardSnapshot({
      mode: params.mode,
      ...(params.previousMode !== undefined ? { previousMode: params.previousMode } : {}),
      planPath: getPlanFilePath(fileCtx),
      planText: params.planText,
    }),
    {
      onPlanTextChange: async nextPlanText => {
        await writePlan(fileCtx, nextPlanText);
      },
    },
  );
}

export const planCommand: SlashCommand = {
  name: "plan",
  description:
    "Enter plan mode or display the current plan (read-only tools only)",
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const registry = getPermissionModeRegistry(ctx.session);
      if (!registry) {
        return {
          kind: "error",
          message:
            "Permission mode registry not initialised on session.services",
        };
      }

      const currentCtx = registry.current();
      const currentMode = currentCtx.mode;
      const argsTrimmed = ctx.argsRaw.trim();

      if (currentMode !== "plan") {
        // Transition into plan mode.
        const nextCtx = {
          ...transitionPermissionMode(currentMode, "plan", currentCtx),
          mode: "plan" as const,
        };
        // Daemon-backed TUI: the local `registry` is a client-side shim the
        // daemon's tool evaluator never reads. Route the plan-mode switch to
        // the daemon's REAL registry via session.setPermissionMode first; if
        // the RPC fails, do not let the local chrome claim plan mode.
        const daemonSetMode = daemonPermissionModeFn(ctx);
        if (daemonSetMode !== null) {
          try {
            await daemonSetMode("plan");
          } catch (err) {
            return {
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }
        await registry.update(nextCtx);
        emitWarning(
          ctx.session,
          "mode_changed_to_plan",
          `entered plan mode (stashed prev mode as ${currentMode})`,
        );

        if (argsTrimmed.length > 0 && argsTrimmed !== "open") {
          // Forward description as a fresh user prompt so the turn loop
          // kicks the model with plan-mode context.
          return { kind: "prompt", content: argsTrimmed };
        }
        if (
          maybeOpenPlanDashboard(ctx, {
            mode: "plan",
            previousMode: currentMode,
            planText: getPlan(planFileContext(ctx)),
          })
        ) {
          return { kind: "skip" };
        }
        return {
          kind: "text",
          text: "Enabled plan mode",
        };
      }

      // Already in plan mode.
      const fileCtx = planFileContext(ctx);
      const plan = getPlan(fileCtx);
      if (!plan) {
        if (
          maybeOpenPlanDashboard(ctx, {
            mode: "plan",
            previousMode: currentCtx.prePlanMode,
            planText: null,
          })
        ) {
          return { kind: "skip" };
        }
        return {
          kind: "text",
          text: "Already in plan mode. No plan written yet.",
        };
      }

      const firstArg = argsTrimmed.split(/\s+/)[0] ?? "";
      if (firstArg === "open") {
        const path = getPlanFilePath(fileCtx);
        const result = await openInEditor(path);
        if ("error" in result) {
          return {
            kind: "text",
            text: `Failed to open plan in editor: ${result.error}`,
          };
        }
        return {
          kind: "text",
          text: `Opened plan in editor: ${path}`,
        };
      }
      if (
        maybeOpenPlanDashboard(ctx, {
          mode: "plan",
          previousMode: currentCtx.prePlanMode,
          planText: plan,
        })
      ) {
        return { kind: "skip" };
      }
      return {
        kind: "text",
        text: formatPlanText(plan, getPlanFilePath(fileCtx)),
      };
    }),
};
