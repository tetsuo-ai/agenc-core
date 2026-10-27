import { getSessionGoal } from "../goal/session-goal.js";
import { createTaskBudgetProgress } from "./task-budget-progress.js";
import { DEFAULT_TASK_TOKEN_BUDGET } from "../config/task-budget.js";
import type { LLMMessage, LLMResponse, LLMUsage } from "../llm/types.js";
import { billableTokenUsage } from "../llm/usage.js";
import type { Session } from "./session.js";

export class TaskBudgetReachedError extends Error {
  constructor() { super("Task budget reached"); this.name = "TaskBudgetReachedError"; }
}

/** Account for provider-specific cache counters and inclusive reasoning once. */
export function taskUsageTokens(usage: LLMUsage): number {
  const { inputTokens, outputTokens } = billableTokenUsage(usage);
  return inputTokens + outputTokens;
}

/** One allocation per session/run, including auxiliary and retry wire attempts. */
export class TaskBudget {
  tokens = 0;
  calls = 0;
  private reserved = 0;
  private activeCalls = 0;
  private lastReservation = 0;
  private announced = false;
  private stopped = false;
  checkpointStopped = false;
  private operatorLimit: number | null = null;
  checkpointAllowance: number | undefined;
  checkpointWarningLimit: number | undefined;
  private extensionAnnounced = false;
  constructor(private readonly hardLimit?: number, readonly maxCalls?: number,
    private readonly progressLimit?: () => number) { this.checkpointAllowance = hardLimit; }
  get limit(): number | undefined { return this.operatorLimit === null ? (this.progressLimit?.() ?? this.hardLimit) : this.operatorLimit === 0 ? undefined : this.operatorLimit; }
  setTokenLimit(tokens: number, checkpoint = false): void {
    if (!checkpoint) this.checkpointAllowance = tokens === 0 ? undefined : tokens;
    this.operatorLimit = tokens;
    this.stopped = false;
    this.checkpointStopped = false;
    this.announced = false;
  }
  stop(): void { this.stopped = true; }
  get reached(): boolean {
    return this.stopped || (this.limit !== undefined && this.tokens >= this.limit) ||
      (this.maxCalls !== undefined && this.calls >= this.maxCalls);
  }
  reminder(): LLMMessage | undefined {
    const currentLimit = this.limit;
    if (!this.extensionAnnounced && this.progressLimit && currentLimit === this.hardLimit) {
      this.extensionAnnounced = true;
      this.announced = false;
      return { role: "user", content: `A host-verified public check changed from failing to passing after a workspace change. Your task allowance was extended once to ${currentLimit} tokens. Finish the fix, run the decisive check, and report. No further extension is available.`, runtimeOnly: { excludeFromDurableHistory: true } };
    }
    if (this.announced || this.reached || !(
      (this.limit !== undefined && (this.tokens >= this.limit * 0.8 ||
        // A growing conversation can spend the entire reserve in one request.
        // Warn while there is still room for roughly two recent-size requests.
        (this.calls > 0 && this.limit - this.tokens <= 2 * this.lastReservation))) ||
      (this.maxCalls !== undefined && this.calls >= this.maxCalls * 0.8))) return undefined;
    this.announced = true;
    return { role: "user", content: "Task budget is nearly exhausted. Finish the most likely fix, run the decisive check, then report the result and anything unverified. Do not start another investigation.",
      runtimeOnly: { excludeFromDurableHistory: true } };
  }
  assertFits(reserve: number): void {
    if (this.reached || (this.limit !== undefined &&
      (!Number.isFinite(reserve) || reserve <= 0 || this.tokens + this.reserved + reserve > this.limit))) {
      this.stopped = true;
      throw new TaskBudgetReachedError();
    }
  }
  /** Reserve before dispatch; an admitted call and its tools are never interrupted. */
  async invoke(reserve: number, invoke: () => Promise<LLMResponse>): Promise<LLMResponse> {
    this.assertFits(reserve);
    this.lastReservation = reserve;
    this.calls += 1;
    this.activeCalls += 1;
    this.reserved += reserve;
    let charge = reserve; // Unknown usage retains the reservation, never becomes free.
    try {
      const response = await invoke();
      if (response.usage.availability === "reported") charge = taskUsageTokens(response.usage);
      return response;
    } finally {
      this.activeCalls -= 1;
      this.reserved -= reserve;
      this.tokens += charge;
    }
  }
  /** A settled durable snapshot replaces old reservations, including downward reconciliation.
   * Local wire calls retain their own holds until they finish; the admission
   * kernel independently reserves shared capacity while they are in flight.
   */
  refreshDurableUsage(usage: { tokens: number; calls: number }): void {
    if (this.activeCalls !== 0) return;
    this.tokens = usage.tokens;
    this.calls = usage.calls;
  }
  summary(lastContent: string): string {
    return ["Partial result: stopped at the task budget.",
      this.limit !== undefined
        ? `The task used ${this.tokens} of ${this.limit} tokens (${this.calls} model calls).`
        : `The task used ${this.tokens} tokens and reached its ${this.maxCalls ?? "configured"} model-call limit.`,
      lastContent.trim().slice(0, 4000) || "No assistant findings were recorded.",
      "Work may be incomplete. Only checks explicitly reported as passing are verified.",
      "Type /budget to raise or remove the token cap for this session, then continue. Independent call and cost limits still apply." +
        (this.maxCalls !== undefined ? " A configured model-call limit requires --task-max-calls in a new session." : "")].join("\n\n");
  }
}

const budgets = new WeakMap<Session, TaskBudget>();
export function taskBudgetOf(session: Session): TaskBudget | undefined {
  const config = session.config;
  // Structural admission clients without a runtime session have no task config.
  if (config === undefined) return undefined;
  const configuredTokens = config?.taskTokenBudget ?? DEFAULT_TASK_TOKEN_BUDGET;
  const limit = configuredTokens === 0 ? undefined : configuredTokens;
  const maxCalls = config?.taskMaxCalls === 0 ? undefined : config?.taskMaxCalls;
  if (limit === undefined && maxCalls === undefined) return undefined;
  let budget = budgets.get(session);
  if (!budget) {
    const progress = config.experimentalTaskBudgetProgress;
    budget = new TaskBudget(limit, maxCalls, progress !== undefined && limit !== undefined
      ? createTaskBudgetProgress(progress, limit) : undefined);
    budgets.set(session, budget);
  }
  const admission = session.services.executionAdmission;
  const taskUsage = admission?.getTaskBudgetUsage?.();
  const usage = taskUsage === undefined ? admission?.getUsageSummary?.() : undefined;
  if (taskUsage !== undefined) budget.refreshDurableUsage(taskUsage);
  else {
    budget.tokens = Math.max(budget.tokens, usage?.totalTokens ?? 0);
    budget.calls = Math.max(budget.calls, usage?.modelCalls ?? 0);
  }
  return budget;
}

/** Replace the root snapshot. Per-turn and config-store snapshots remain immutable. */
export function replaceSessionTaskTokenBudgetSnapshot(session: Pick<Session, "config">, tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Invalid task token allowance");
  (session as { config: Session["config"] }).config = Object.freeze({ ...session.config, taskTokenBudget: tokens });
}

/** Host/operator-only update; never resets usage or independent call/cost limits. */
export function setSessionTaskTokenBudget(session: Session, tokens: number, checkpoint = false): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Invalid task token allowance");
  const admission = session.services?.executionAdmission;
  if (admission !== undefined && admission.setTaskTokenBudget === undefined) {
    throw new Error("This admission authority cannot update a task allowance");
  }
  const effective = admission?.setTaskTokenBudget?.(tokens) ?? tokens;
  replaceSessionTaskTokenBudgetSnapshot(session, effective);
  budgets.get(session)?.setTokenLimit(effective, checkpoint);
  session.emit?.({ id: session.nextInternalSubId(), msg: { type: "warning", payload: {
    cause: "task_budget_changed",
    message: "Task token allowance updated.",
    details: { taskTokenBudget: effective },
  } } }, { durable: true });
  return effective;
}

export function interactiveTaskBudget(session: Session): boolean {
  const options = session.services.runtimeOptions;
  const scope = session.services.executionAdmission?.scope;
  return options?.interactiveTaskBudget === true && options.nonInteractive === false && options.routineRun !== true &&
    session.config.autonomousMode !== true && scope?.parentRunId === undefined &&
    session.permissionModeRegistry.current().unattendedPolicy === undefined &&
    getSessionGoal(session)?.status !== "active";
}

const checkpointWaits = new WeakMap<Session, Promise<boolean>>();
/** Pauses before the next model lease. A human may raise only this task cap. */
export async function continueInteractiveTaskBudget(session: Session, reserve = 0, signal?: AbortSignal): Promise<boolean> {
  const budget = taskBudgetOf(session);
  if (!budget) return true;
  if (budget.checkpointStopped) return false;
  if (budget.maxCalls !== undefined && budget.calls >= budget.maxCalls) return false;
  if (budget.limit === undefined) return true;
  if (!interactiveTaskBudget(session)) return false;
  const limit = budget.limit;
  const allowance = budget.checkpointAllowance ?? limit;
  if (budget.tokens >= limit - allowance * 0.2 && budget.checkpointWarningLimit !== limit) {
    budget.checkpointWarningLimit = limit;
    session.emit({ id: session.nextInternalSubId(), msg: { type: "warning", payload: {
      cause: "task_budget_near_limit", message: `Task budget: ${budget.tokens.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} tokens used. A checkpoint will ask before more work crosses the allowance.`,
    } } });
  }
  if (!budget.reached && budget.tokens + reserve <= limit) return true;
  const waiting = checkpointWaits.get(session);
  if (waiting !== undefined) return waiting;
  const ask = async (): Promise<boolean> => {
    const cost = session.services.executionAdmission?.getUsageSummary?.().costUsd;
    const price = typeof cost === "number" && Number.isFinite(cost) ? ` (about $${cost.toFixed(2)})` : " (cost unavailable)";
    const response = await session.requestUserInput(`task-budget-checkpoint-${session.nextInternalSubId()}`, { questions: [{
      id: "task_budget", header: "Task budget", isOther: false, isSecret: false,
      question: `This task used ${budget.tokens.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} tokens${price}. The next model call needs more room. Continue?`,
      options: [
        { label: "Continue", description: `Add another ${allowance.toLocaleString("en-US")} tokens and ask at the next checkpoint.` },
        { label: "Remove the limit for this task", description: "Continue without task token checkpoints. Independent limits still apply." },
        { label: "Stop here", description: "Keep the partial result and stop this turn." },
      ],
    }] }, signal);
    const choice = response?.answers.task_budget?.answers[0];
    if (choice !== "Continue" && choice !== "Remove the limit for this task") {
      budget.checkpointStopped = true;
      budget.stop();
      return false;
    }
    const next = choice === "Continue" ? limit + allowance : 0;
    if (!Number.isSafeInteger(next)) throw new Error("Task allowance is too large");
    const effective = setSessionTaskTokenBudget(session, next, true);
    // An independent admission ceiling cannot be raised by this card.
    return effective === 0 || effective > limit;
  };
  const pending = ask();
  checkpointWaits.set(session, pending);
  try { return await pending; } finally { checkpointWaits.delete(session); }
}

export async function prepareInteractiveTaskBudgetCall(session: Session, reserve: number, signal?: AbortSignal): Promise<void> {
  const budget = taskBudgetOf(session);
  if (!budget || !interactiveTaskBudget(session)) return;
  while (budget.limit !== undefined && (budget.reached || budget.tokens + reserve > budget.limit)) {
    if (!await continueInteractiveTaskBudget(session, reserve, signal)) { budget.stop(); throw new TaskBudgetReachedError(); }
  }
  await continueInteractiveTaskBudget(session, 0, signal);
}
