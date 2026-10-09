import { createTaskBudgetProgress } from "./task-budget-progress.js";
import { DEFAULT_TASK_TOKEN_BUDGET } from "../config/task-budget.js";
import type { LLMMessage, LLMResponse, LLMUsage } from "../llm/types.js";
import type { Session } from "./session.js";

export class TaskBudgetReachedError extends Error {
  constructor() { super("Task budget reached"); this.name = "TaskBudgetReachedError"; }
}

/** Provider totals include reasoning and cached input; neither is added twice. */
export function taskUsageTokens(usage: LLMUsage): number {
  return Math.max(usage.totalTokens, usage.promptTokens + usage.completionTokens,
    usage.promptTokens + (usage.reasoningOutputTokens ?? 0));
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
  private extensionAnnounced = false;
  constructor(private readonly hardLimit?: number, readonly maxCalls?: number,
    private readonly progressLimit?: () => number) {}
  get limit(): number | undefined { return this.progressLimit?.() ?? this.hardLimit; }
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
      `Recorded allocation usage: ${this.tokens} tokens, ${this.calls} model calls.`,
      `Limits: ${this.limit ?? "unlimited"} tokens, ${this.maxCalls ?? "unlimited"} model calls.`,
      lastContent.trim().slice(0, 4000) || "No assistant findings were recorded.",
      "Work may be incomplete. Only checks explicitly reported as passing are verified.",
      "To allow more work, start a new session with --task-token-budget <tokens> or set task_token_budget in config. Use 0 to disable the token limit. If a call limit was set, raise --task-max-calls <calls> (task_max_calls in config), or use 0 to disable it."].join("\n\n");
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
