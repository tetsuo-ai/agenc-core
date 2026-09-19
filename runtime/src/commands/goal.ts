/**
 * `/goal` — keep the session working until the runtime confirms an end state.
 *
 *   /goal <objective> [--verify "label=cmd"]… [--max-rounds N] [--max-cost USD] [--no-verify]
 *   /goal                 status
 *   /goal pause | resume | clear   (clear aliases: stop, off, cancel, reset, none)
 *
 * The command only parses and talks to the daemon (`session.goal`). What a goal
 * is, how a round is decided, and why, live in `goal/goal.ts`,
 * `phases/goal-gate.ts` and `docs/reference/goal.md`.
 *
 * @module
 */
import { parseGoalCommand, type GoalSetRequest } from "../goal/intake.js";
import type {
  SessionGoalParams,
  SessionGoalResult,
  SessionGoalSnapshot,
} from "../app-server/protocol/index.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type GoalBridge = (
  params: Omit<SessionGoalParams, "sessionId">,
) => Promise<SessionGoalResult>;

function goalBridge(ctx: SlashCommandContext): GoalBridge | null {
  const candidate = (
    ctx.session as unknown as { updateDaemonSessionGoal?: GoalBridge }
  ).updateDaemonSessionGoal;
  return typeof candidate === "function"
    ? candidate.bind(ctx.session)
    : null;
}

const STATUS_LABEL: Readonly<Record<SessionGoalSnapshot["status"], string>> = {
  active: "active",
  paused: "paused",
  met: "met",
  impossible: "impossible",
  blocked: "blocked (needs you)",
  budget_exhausted: "stopped: budget exhausted",
  stalled: "stopped: no progress",
  cleared: "cleared",
};

function elapsed(startedAt: string, now: number): string {
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatGoalStatus(
  goal: SessionGoalSnapshot,
  sessionCostUsd: number | undefined,
  now: number = Date.now(),
): string {
  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${STATUS_LABEL[goal.status]}${goal.pauseReason ? ` (${goal.pauseReason})` : ""}`,
    `Rounds: ${goal.rounds} of ${goal.budget.maxRounds} · running ${elapsed(goal.startedAt, now)}` +
      (sessionCostUsd !== undefined
        ? ` · spent $${Math.max(0, sessionCostUsd - goal.startCostUsd).toFixed(2)}` +
          (goal.budget.maxCostUsd !== undefined
            ? ` of $${goal.budget.maxCostUsd.toFixed(2)}`
            : "")
        : ""),
    goal.verification.length > 0
      ? `Verified by: ${goal.verification.map((command) => `${command.label} (\`${command.script}\`)`).join(", ")}`
      : "Verified by: independent review only (--no-verify)",
  ];
  if (goal.lastVerdict !== undefined) {
    lines.push(`Last verdict: ${goal.lastVerdict.verdict.replace("_", " ")} — ${goal.lastVerdict.reason}`);
  }
  if (goal.status === "paused" || goal.status === "stalled" || goal.status === "budget_exhausted" || goal.status === "blocked") {
    lines.push("Run /goal resume to continue, or /goal clear to drop it.");
  }
  return lines.join("\n");
}

function kickoffPrompt(request: GoalSetRequest): string {
  return [
    "Work toward this goal until the runtime confirms it is met:",
    "",
    request.objective,
  ].join("\n");
}

export const goalCommand: SlashCommand = {
  name: "goal",
  description: "Keep working until a verified end state is reached",
  argumentHint: '<objective> [--verify "label=command"] | pause | resume | clear',
  supportedSurfaces: ["daemon-tui"],
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parsed = parseGoalCommand(ctx.argsRaw);
      if (parsed.kind === "error") return { kind: "error", message: parsed.message };
      const bridge = goalBridge(ctx);
      if (bridge === null) {
        return { kind: "error", message: "/goal needs a daemon-backed session." };
      }
      if (parsed.kind === "status") {
        const result = await bridge({ action: "get" });
        return {
          kind: "text",
          text:
            result.goal === undefined
              ? "No goal is set. Start one with /goal <objective>."
              : formatGoalStatus(result.goal, result.sessionCostUsd),
        };
      }
      if (parsed.kind === "set") {
        const { request } = parsed;
        const result = await bridge({
          action: "set",
          request: {
            objective: request.objective,
            verify: request.verify.map((command) => ({ ...command })),
            noVerify: request.noVerify,
            ...(request.maxRounds !== undefined ? { maxRounds: request.maxRounds } : {}),
            ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
          },
        });
        if (!result.ok) {
          return { kind: "error", message: result.message ?? "The goal was refused." };
        }
        // Setting a goal starts the work: the objective is the first turn.
        return { kind: "prompt", content: kickoffPrompt(request) };
      }
      const result = await bridge({ action: parsed.kind });
      if (!result.ok) {
        return { kind: "error", message: result.message ?? `/goal ${parsed.kind} failed.` };
      }
      if (parsed.kind === "resume") {
        return {
          kind: "prompt",
          content: "Continue working toward the active goal. Start by checking where things stand.",
        };
      }
      return {
        kind: "text",
        text:
          parsed.kind === "clear"
            ? (result.message ?? "Goal cleared.")
            : result.goal !== undefined
              ? formatGoalStatus(result.goal, result.sessionCostUsd)
              : "Goal paused.",
      };
    }),
};
