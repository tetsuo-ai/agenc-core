/**
 * Heartbeat tick runner (TODO task 14).
 *
 * One tick, in order:
 *   1. gates: enabled, active hours, cron-running defer, skip-when-busy
 *   2. HEARTBEAT.md present? (absent → nothing to do)
 *   3. run the heartbeat turn; model/tool admission happens inside its
 *      daemon-owned session
 *   4. HEARTBEAT_OK reply → suppress delivery; otherwise deliver
 */

import {
  HEARTBEAT_OK,
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
  /** True while a cron job is executing (defer). Default: never. */
  readonly isCronRunning?: () => boolean;
  readonly log?: (line: string) => void;
}

/** The system framing prepended to HEARTBEAT.md for a heartbeat turn. */
export function heartbeatPrompt(heartbeatFile: string): string {
  return (
    "This is an automated heartbeat tick. Read the instructions below and do " +
    "only what they require right now. If nothing needs attention, reply with " +
    `exactly ${HEARTBEAT_OK} and nothing else.\n\n` +
    `<heartbeat_instructions>\n${heartbeatFile}\n</heartbeat_instructions>`
  );
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
    const prompt = heartbeatPrompt(heartbeatFile);

    const result = await this.#o.turnRunner.run(prompt);
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
