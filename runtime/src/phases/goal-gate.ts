/**
 * Phase 4c — the goal gate (`/goal`).
 *
 * While a session has an active goal, a tool-free "I'm done" is not the end of
 * the turn. The runtime decides, in this order:
 *
 *   1. budget and stall checks (neither is completion),
 *   2. it runs the goal's verification commands ITSELF and reads exit codes,
 *   3. it lists verification files that changed since the goal was set,
 *   4. only when every command passes, an independent reviewer in a fresh
 *      context judges the diff against the objective,
 *   5. `met` ends the goal; anything else re-enters the loop with the real
 *      output and the objective quoted verbatim.
 *
 * The worker's claim decides nothing. That is the point: premature
 * termination and missing or incorrect verification are 23.5% of observed
 * agent failures (MAST, arXiv:2503.13657), models do not self-correct without
 * external feedback (arXiv:2310.01798), judges favour their own output
 * (arXiv:2404.13076), and agents pass checks by weakening them (METR 2025;
 * arXiv:2510.20270; arXiv:2605.21384). The decision table is pure and lives in
 * `goal/goal.ts`; this module only gathers observations and applies it.
 *
 * Mechanics mirror the completion gate (Phase 4b): a durable injected user
 * message plus `transition`, so a resumed turn sees what it was asked. While a
 * goal is active this phase supersedes 4b, so the model never receives two
 * competing requests for the same answer.
 *
 * @module
 */
import {
  buildGoalJudgeUserMessage,
  classifyTamperedPaths,
  decideGoalRound,
  DEFAULT_GOAL_STALL_ROUNDS,
  GOAL_JUDGE_REPAIR_INSTRUCTION,
  GOAL_JUDGE_SYSTEM_PROMPT,
  isGoalLive,
  parseGoalJudgeOutput,
  preflightGoalRound,
  verificationPassed,
  type GoalJudgeOutput,
  type GoalVerificationResult,
  type SessionGoal,
} from "../goal/goal.js";
import {
  DEFAULT_GOAL_VERIFY_TIMEOUT_MS,
  defaultGoalGateDeps,
  type GoalGateDeps,
} from "../goal/runtime-deps.js";
import { commitSessionGoal, getSessionGoal } from "../goal/session-goal.js";
import type { LLMMessage } from "../llm/types.js";
import { isPlanMode } from "../session/plan-mode.js";
import { inDeadlineReserve } from "../session/run-deadline.js";
import { isSubagentSessionSource } from "../session/run-turn-queued-commands.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  CompletedToolResultRecord,
  TurnState,
} from "../session/turn-state.js";

let activeDeps: GoalGateDeps = defaultGoalGateDeps;

/** Test seam: scripted verification, diff and judge. Returns the restore function. */
export function setGoalGateDepsForTests(deps: GoalGateDeps): () => void {
  const previous = activeDeps;
  activeDeps = deps;
  return () => {
    activeDeps = previous;
  };
}

/** True when this turn is one the goal gate governs. */
export function goalGateApplies(
  ctx: TurnContext,
  session: Pick<Session, "sessionConfiguration">,
  goal: SessionGoal | undefined,
): goal is SessionGoal {
  if (goal === undefined || !isGoalLive(goal.status)) return false;
  if (ctx.depth !== 0) return false;
  if (isPlanMode(ctx)) return false;
  const source = session.sessionConfiguration?.sessionSource;
  return !(source !== undefined && isSubagentSessionSource(source));
}

function isSuccessful(result: CompletedToolResultRecord): boolean {
  return result.isError !== true;
}

function warn(session: Session, ctx: TurnContext, cause: string, message: string): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: { type: "warning", payload: { turnId: ctx.subId, cause, message } },
  });
}

async function askJudge(input: {
  readonly goal: SessionGoal;
  readonly verification: readonly GoalVerificationResult[];
  readonly tamperedPaths: readonly string[];
  readonly workerFinalMessage: string;
  readonly ctx: TurnContext;
  readonly session: Session;
  readonly signal?: AbortSignal;
}): Promise<GoalJudgeOutput | undefined> {
  const { goal, ctx, session, signal } = input;
  const { stat, diff } = await activeDeps.diff(ctx.cwd, goal.baseCommit);
  const userMessage = buildGoalJudgeUserMessage({
    goal,
    verification: input.verification,
    tamperedPaths: input.tamperedPaths,
    diffStat: stat,
    diff,
    // Only a failing round can hear the worker out, and only to stop.
    ...(verificationPassed(input.verification)
      ? {}
      : { workerFinalMessage: input.workerFinalMessage }),
  });
  const model = ctx.config.goal?.judge_model;
  const ask = (message: string): Promise<string> =>
    activeDeps.judge({
      systemPrompt: GOAL_JUDGE_SYSTEM_PROMPT,
      userMessage: message,
      model,
      ctx,
      session,
      ...(signal !== undefined ? { signal } : {}),
    });
  try {
    const first = parseGoalJudgeOutput(await ask(userMessage));
    if (first !== undefined) return first;
    // One repair turn, then no verdict. Never an implicit pass.
    return parseGoalJudgeOutput(
      await ask(`${userMessage}\n\n${GOAL_JUDGE_REPAIR_INSTRUCTION}`),
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    warn(
      session,
      ctx,
      "goal_judge_unavailable",
      `the independent goal reviewer could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Returns true when the gate took the answer (injected a continuation or
 * settled the goal), so Phase 4b must not also act on it.
 */
export async function goalGate(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<boolean> {
  const goal = getSessionGoal(session);
  if (!goalGateApplies(ctx, session, goal)) return false;
  // Only a tool-free sample is a candidate final answer.
  if (state.toolUseBlocks.length > 0 || state.needsFollowUp) return true;
  if (state.transition !== undefined) return true;
  const last = state.assistantMessages.at(-1);
  if (last === undefined || last.apiError !== undefined) return true;
  if ((last.text ?? "").trim().length === 0) return true;
  const maxTurns =
    (ctx.config as { maxTurns?: number }).maxTurns ?? Number.POSITIVE_INFINITY;
  if (state.turnCount >= maxTurns) return true;

  const now = activeDeps.now();
  const sinceInjection = state.completedToolResults
    .slice(state.goalGateToolLedgerMark)
    .filter(isSuccessful).length;
  const preflight = preflightGoalRound({
    goal,
    now,
    sessionCostUsd: activeDeps.sessionCostUsd(session),
    inDeadlineReserve: inDeadlineReserve(session),
    successfulToolResultsSinceInjection: sinceInjection,
    stallRounds: ctx.config.goal?.stall_rounds ?? DEFAULT_GOAL_STALL_ROUNDS,
  });
  if (preflight.kind === "settle") {
    commitSessionGoal(
      session,
      {
        ...goal,
        status: preflight.status,
        pauseReason: preflight.reason,
      },
      "settled",
      ctx.subId,
    );
    warn(
      session,
      ctx,
      `goal_${preflight.status}`,
      `goal stopped without being met: ${preflight.reason}. Run /goal resume to continue or /goal clear to drop it.`,
    );
    return true;
  }

  const verification = await activeDeps.runVerification({
    commands: goal.verification,
    ctx,
    session,
    timeoutMs: ctx.config.goal?.verify_timeout_ms ?? DEFAULT_GOAL_VERIFY_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  });
  const tamperedPaths = classifyTamperedPaths(
    await activeDeps.changedPaths(ctx.cwd, goal.baseCommit),
    goal.verification,
  );
  const judge = await askJudge({
    goal,
    verification,
    tamperedPaths,
    workerFinalMessage: last.text ?? "",
    ctx,
    session,
    ...(signal !== undefined ? { signal } : {}),
  });
  const decision = decideGoalRound({ goal, now, verification, tamperedPaths, judge });

  if (decision.kind === "settle") {
    commitSessionGoal(
      session,
      {
        ...goal,
        status: decision.status,
        stalledRounds: 0,
        lastVerdict: decision.verdict,
      },
      "settled",
      ctx.subId,
    );
    warn(
      session,
      ctx,
      `goal_${decision.status}`,
      decision.status === "met"
        ? `goal met ${goal.rounds === 0 ? "on the first check" : `after ${goal.rounds} ${goal.rounds === 1 ? "round" : "rounds"}`}: ${decision.verdict.reason}`
        : `goal ${decision.status}: ${decision.verdict.reason}`,
    );
    return true;
  }

  commitSessionGoal(
    session,
    {
      ...goal,
      rounds: goal.rounds + 1,
      stalledRounds: preflight.stalledRounds,
      lastVerdict: decision.verdict,
    },
    "round",
    ctx.subId,
  );
  warn(
    session,
    ctx,
    "goal_round",
    `goal round ${goal.rounds + 1} of ${goal.budget.maxRounds}: ${decision.verdict.reason}. Continuing.`,
  );
  state.goalGateToolLedgerMark = state.completedToolResults.length;
  // Durable, like the completion gate's request: a resumed turn must see it.
  const message: LLMMessage = { role: "user", content: decision.message };
  state.messages.push(message);
  // Same recovery-shared resets as the completion gate: the re-entry is a
  // fresh sample, not a continuation of a recovery ladder.
  state.maxOutputTokensRecoveryCount = 0;
  state.hasAttemptedReactiveCompact = false;
  state.maxOutputTokensOverride = undefined;
  state.pendingToolUseSummary = undefined;
  state.stopHookActive = undefined;
  state.transition = { reason: "goal_gate" };
  return true;
}
