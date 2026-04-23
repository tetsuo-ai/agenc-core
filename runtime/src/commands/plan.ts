/**
 * `/plan` — enter plan mode or display the active plan.
 *
 * Port of openclaude `src/commands/plan/plan.tsx` adapted to AgenC's
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
 * Plan storage path decision: plans live under
 * `<ctx.cwd>/.agenc/plan.json` (project-scoped) so multiple sessions
 * operating on the same project share a single plan file. Session-scoped
 * storage under `~/.agenc/sessions/<id>/plan.json` was rejected because
 * openclaude's plan file is explicitly designed to survive session boundaries.
 *
 * Dependency: expects `session.services.permissionModeRegistry`.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  PermissionModeRegistry,
  transitionPermissionMode,
} from "../permissions/mode.js";
import type { Session } from "../session/session.js";
import type { EventMsg } from "../session/event-log.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Plan-file primitives
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal plan record — mirrors openclaude's `Plan` shape without pulling
 * in their protocol types. `items` is free-form string content today; a
 * future tranche can replace with structured PlanItem[] once the TUI
 * learns to render it.
 */
export interface PlanRecord {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Project-scoped plan file path: `<cwd>/.agenc/plan.json`. Exported so
 * tests can assert the resolved path without replicating the join logic.
 */
export function getPlanFilePath(cwd: string): string {
  return resolve(cwd, ".agenc", "plan.json");
}

/** Read the plan file if present; returns `null` on absent or malformed. */
export function getPlan(cwd: string): PlanRecord | null {
  const path = getPlanFilePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PlanRecord>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.description === "string" &&
      typeof parsed.content === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string"
    ) {
      return parsed as PlanRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a plan record to disk under `<cwd>/.agenc/plan.json`. Creates
 * the `.agenc` directory if needed. Exposed so higher tranches (plan
 * verification hook, interview phase) can write plans programmatically.
 */
export async function writePlan(
  cwd: string,
  plan: PlanRecord,
): Promise<void> {
  const path = getPlanFilePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(plan, null, 2), "utf8");
}

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

/**
 * Format a plan record for terminal display. Kept as a pure helper so
 * tests don't need stdout capture.
 */
export function formatPlanText(plan: PlanRecord, path: string): string {
  const lines = [
    "Current Plan",
    path,
    "",
    plan.description.trim().length > 0 ? plan.description : "(no description)",
    "",
    plan.content.trim().length > 0 ? plan.content : "(plan body empty)",
  ];
  return lines.join("\n");
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

function emitWarning(session: Session, cause: string, message: string): void {
  const msg: EventMsg = {
    type: "warning",
    payload: { cause, message },
  };
  session.emit({ id: session.nextInternalSubId(), msg });
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
        return {
          kind: "text",
          text:
            "Entered plan mode. Only read-only tools are available. " +
            "Use Shift+Tab to cycle out or call /plan again to view the plan.",
        };
      }

      // Already in plan mode.
      if (argsTrimmed === "open") {
        const path = getPlanFilePath(ctx.cwd);
        const result = await openInEditor(path);
        if ("error" in result) {
          return {
            kind: "text",
            text: `Could not open plan in editor (${result.error}). Path: ${path}`,
          };
        }
        return { kind: "skip" };
      }

      const plan = getPlan(ctx.cwd);
      if (!plan) {
        return {
          kind: "text",
          text:
            "Already in plan mode. No plan written yet — describe your goal so the model can draft one.",
        };
      }
      return {
        kind: "text",
        text: formatPlanText(plan, getPlanFilePath(ctx.cwd)),
      };
    }),
};

export default planCommand;
