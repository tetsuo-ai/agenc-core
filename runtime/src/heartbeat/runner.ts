/**
 * Heartbeat tick runner (TODO task 14).
 *
 * One tick, in order:
 *   1. gates: enabled, active hours, cron-running defer, skip-when-busy
 *   2. HEARTBEAT.md present? (absent → nothing to do)
 *   3. BUDGET ADMIT (task-15 enforcer): worst-case pre-flight. On refusal the
 *      turn is NOT run — the budget layer has already paused autonomy — and a
 *      one-line budget notice is delivered to the target (fail closed, visible,
 *      never a silent skip).
 *   4. run the heartbeat turn on the utility model
 *   5. HEARTBEAT_OK reply → suppress delivery; otherwise deliver
 *   6. reconcile the budget from the real usage
 */

import {
  HEARTBEAT_OK,
  type HeartbeatBudgetGate,
  type HeartbeatClock,
  type HeartbeatDelivery,
  type HeartbeatFileReader,
  type HeartbeatPolicy,
  type HeartbeatTickOutcome,
  type HeartbeatTurnRunner,
} from "./types.js";

export interface HeartbeatRunnerOptions {
  readonly policy: HeartbeatPolicy;
  readonly clock: HeartbeatClock;
  readonly turnRunner: HeartbeatTurnRunner;
  readonly delivery: HeartbeatDelivery;
  readonly file: HeartbeatFileReader;
  /** Optional budget gate; when absent, no budget enforcement. */
  readonly budget?: HeartbeatBudgetGate;
  /** True while a cron job is executing (defer). Default: never. */
  readonly isCronRunning?: () => boolean;
  readonly log?: (line: string) => void;
  /** Rough worst-case output cap for the pre-flight debit. */
  readonly maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** The system framing prepended to HEARTBEAT.md for a heartbeat turn. */
export function heartbeatPrompt(heartbeatFile: string): string {
  return (
    "This is an automated heartbeat tick. Read the instructions below and do " +
    "only what they require right now. If nothing needs attention, reply with " +
    `exactly ${HEARTBEAT_OK} and nothing else.\n\n` +
    `<heartbeat_instructions>\n${heartbeatFile}\n</heartbeat_instructions>`
  );
}

/** Rough token estimate (chars/4) — deterministic, not a model guess. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function withinActiveHours(policy: HeartbeatPolicy, now: Date): boolean {
  if (policy.activeHours === null) return true;
  const [start, end] = policy.activeHours;
  const hour = now.getHours();
  return hour >= start && hour < end;
}

export class HeartbeatRunner {
  readonly #o: HeartbeatRunnerOptions;
  #busy = false;

  constructor(options: HeartbeatRunnerOptions) {
    this.#o = options;
  }

  /** Run one tick; never throws (errors become an `error` outcome). */
  async tick(): Promise<HeartbeatTickOutcome> {
    const { policy } = this.#o;
    if (!policy.enabled) return { kind: "skipped", reason: "disabled" };
    if (!withinActiveHours(policy, this.#o.clock.now())) {
      return { kind: "skipped", reason: "outside_active_hours" };
    }
    if (this.#o.isCronRunning?.() === true) {
      return { kind: "skipped", reason: "cron_running" };
    }
    if (policy.skipWhenBusy && this.#busy) {
      return { kind: "skipped", reason: "busy" };
    }

    const heartbeatFile = this.#o.file.read();
    if (heartbeatFile === null || heartbeatFile.trim().length === 0) {
      return { kind: "skipped", reason: "no_heartbeat_file" };
    }

    this.#busy = true;
    try {
      return await this.#run(heartbeatFile);
    } catch (error) {
      return { kind: "error", message: String(error) };
    } finally {
      this.#busy = false;
    }
  }

  async #run(heartbeatFile: string): Promise<HeartbeatTickOutcome> {
    const { policy } = this.#o;
    const prompt = heartbeatPrompt(heartbeatFile);
    const model = policy.model ?? "";
    const maxOutputTokens = this.#o.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // 3. Budget pre-flight (task 15). A refusal means autonomy is paused; do
    // NOT run the turn — surface it instead of silently spending or skipping.
    let hold: unknown = null;
    if (this.#o.budget !== undefined) {
      // Prefer policy model; never admit as "unknown" under USD caps (todo-104).
      const admitModel = model.length > 0 ? model : "grok-4.3";
      const admit = this.#o.budget.admit({
        agentId: policy.agentId,
        model: admitModel,
        estInputTokens: estimateTokens(prompt),
        maxOutputTokens,
      });
      if (!admit.ok) {
        const notice = `⏸ heartbeat paused: ${admit.message}`;
        await this.#deliver(notice);
        this.#o.log?.(`heartbeat: ${notice}`);
        return { kind: "budget_paused", message: admit.message };
      }
      hold = admit.hold;
    }

    // 4. Run the turn.
    const result = await this.#o.turnRunner.run(
      prompt,
      model.length > 0 ? model : undefined,
    );

    // 6. Reconcile budget from real usage (fall back to nothing if absent).
    if (this.#o.budget !== undefined && hold !== null) {
      this.#o.budget.reconcile(
        hold,
        result.usage ?? { inputTokens: 0, outputTokens: 0 },
      );
    }

    // 5. HEARTBEAT_OK suppression.
    const reply = result.finalMessage.trim();
    if (reply === HEARTBEAT_OK || reply.length === 0) {
      return { kind: "ok_suppressed" };
    }
    await this.#deliver(reply);
    return { kind: "delivered", text: reply };
  }

  async #deliver(text: string): Promise<void> {
    if (this.#o.policy.target.kind === "none") return;
    await this.#o.delivery.deliver(this.#o.policy.target, text);
  }
}
