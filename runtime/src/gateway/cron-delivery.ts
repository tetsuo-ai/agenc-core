/**
 * Gateway cron delivery (TODO task 16).
 *
 * Runs delivery-tagged cron tasks (`CronTask.deliver` set) in ISOLATED
 * gateway daemon sessions — heartbeat parity — and routes each result to a
 * channel adapter and/or a webhook POST. The in-session cron scheduler skips
 * these tasks (cronScheduler loadRunnableTasks), so the gateway is their
 * exclusive executor and a fire is never double-run.
 *
 * Scheduling: sleep-until-earliest-due with a scan cap. Every wake re-reads
 * `.agenc/scheduled_tasks.json` (cheap, non-model), fires the due tasks
 * (each past-due schedule coalesces to ONE fire), stamps `lastFiredAt` /
 * deletes one-shots, and re-arms. The scan cap bounds how stale the armed
 * timer can get when tasks are added by another process — the model is still
 * only invoked when a task is concretely due.
 *
 * Turns reuse the SessionRouter: one persistent daemon session per task
 * (`cron|<id>`), dead-agent retry, and channel streaming for free. Turns are
 * autonomous: permission requests are DENIED and the task-15 budget envelope
 * gates every fire (refusal delivers a paused notice, never silent).
 */

import type { AgenCConfig } from "../config/schema.js";
import {
  BudgetEnforcer,
  BudgetLedger,
  createModelPriceResolver,
  resolveBudgetPolicy,
} from "../budget/index.js";
import {
  listAllCronTasks,
  markCronTasksFired,
  nextCronRunMs,
  removeCronTasks,
  type CronTask,
} from "../utils/cronTasks.js";
import { SessionRouter } from "./session-router.js";
import type { ChannelAdapter, GatewayDaemonClient } from "./types.js";

/** Upper bound on one sleep so externally-added tasks are noticed. */
export const CRON_DELIVERY_SCAN_CAP_MS = 5 * 60 * 1000;

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/** Deterministic ~chars/4 token estimate (mirrors the heartbeat runner). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface CronDeliveryClock {
  now(): Date;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

const REAL_CLOCK: CronDeliveryClock = {
  now: () => new Date(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
};

export interface StartCronDeliveryOptions {
  readonly agencHome: string;
  /** Workspace holding `.agenc/scheduled_tasks.json`. */
  readonly workspaceDir: string;
  readonly config: AgenCConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly client: GatewayDaemonClient;
  readonly adapters: readonly ChannelAdapter[];
  readonly log?: (line: string) => void;
  /** Test seam: real timers by default. */
  readonly clock?: CronDeliveryClock;
  /** Test seam: webhook transport (global fetch by default). */
  readonly postWebhook?: (url: string, body: unknown) => Promise<void>;
}

export interface CronDeliveryHandle {
  /** True while a delivery turn is in flight (heartbeat skip-when-busy seam). */
  isRunning(): boolean;
  stop(): Promise<void>;
}

async function defaultPostWebhook(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Adapter used when a task delivers to a webhook only — swallows channel output. */
const NULL_ADAPTER: ChannelAdapter = {
  id: "cron-webhook-null",
  supportsEdit: false,
  async start() {},
  async stop() {},
  async send() {
    return "cron-null";
  },
};

export function startCronDelivery(
  options: StartCronDeliveryOptions,
): CronDeliveryHandle {
  const log = options.log ?? (() => {});
  const clock = options.clock ?? REAL_CLOCK;
  const env = options.env ?? {};
  const postWebhook = options.postWebhook ?? defaultPostWebhook;
  const adaptersById = new Map(options.adapters.map((a) => [a.id, a]));

  const { policy: budgetPolicy } = resolveBudgetPolicy(
    options.config.budget,
    env,
  );
  const enforcer = new BudgetEnforcer({
    policy: budgetPolicy,
    ledger: new BudgetLedger({ agencHome: options.agencHome }),
    priceOf: createModelPriceResolver(),
    notify: (e) => log(`cron/budget: ${e.message}`),
  });

  const router = new SessionRouter({
    agencHome: options.agencHome,
    client: options.client,
  });

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deliveredTasks = async (): Promise<CronTask[]> => {
    const tasks = await listAllCronTasks(options.workspaceDir);
    return tasks.filter((t) => t.deliver !== undefined);
  };

  const fireTask = async (task: CronTask): Promise<void> => {
    const deliver = task.deliver;
    if (deliver === undefined) return;
    const adapter =
      deliver.channel !== undefined
        ? adaptersById.get(deliver.channel)
        : undefined;
    if (deliver.channel !== undefined && adapter === undefined) {
      log(
        `cron: task ${task.id} targets unknown channel '${deliver.channel}' — skipping channel delivery this fire`,
      );
    }
    const routeAdapter = adapter ?? NULL_ADAPTER;
    const conversationId = adapter !== undefined ? deliver.to ?? "" : "cron";

    // Budget pre-flight: cron fires are autonomous turns. A refusal delivers
    // a paused notice instead of running the turn (never silent).
    const admit = enforcer.admit({
      agentId: `cron:${task.id}`,
      model: "unknown",
      autonomous: true,
      estInputTokens: estimateTokens(task.prompt),
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    if (!admit.ok) {
      const notice = `⏸ cron task ${task.id} paused: ${admit.message}`;
      log(`cron: ${notice}`);
      if (adapter !== undefined && deliver.to !== undefined) {
        await adapter
          .send({ conversationId: deliver.to, text: notice })
          .catch((error: unknown) => log(`cron: notice failed: ${String(error)}`));
      }
      return;
    }

    const result = await router.runTurn({
      key: SessionRouter.conversationKey({
        channelId: "cron",
        agent: "default",
        conversationId: task.id,
      }),
      text: task.prompt,
      adapter: routeAdapter,
      conversationId,
      // Autonomous, no human watching → deny permission requests (fail safe).
      onPermissionRequest: async () => ({
        behavior: "deny",
        reason: "cron delivery turns do not grant tool permissions",
      }),
    });

    enforcer.reconcile(
      admit.hold,
      result.usage ?? { inputTokens: 0, outputTokens: 0 },
    );

    if (deliver.webhook !== undefined) {
      await postWebhook(deliver.webhook, {
        taskId: task.id,
        cron: task.cron,
        prompt: task.prompt,
        finalMessage: result.finalMessage,
        stopReason: result.stopReason,
        firedAt: clock.now().toISOString(),
      }).catch((error: unknown) =>
        log(`cron: webhook POST failed for task ${task.id}: ${String(error)}`),
      );
    }
    log(`cron: task ${task.id} delivered (${result.stopReason})`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const now = clock.now().getTime();
      const tasks = await deliveredTasks();
      const firedRecurring: CronTask[] = [];
      const firedOneShots: string[] = [];
      for (const task of tasks) {
        // Anchor from the last fire (or creation) — a past-due schedule
        // coalesces to ONE fire regardless of how many slots were missed.
        const due = nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
        if (due === null || due > now) continue;
        try {
          await fireTask(task);
        } catch (error) {
          log(`cron: task ${task.id} failed: ${String(error)}`);
        }
        if (task.recurring === true) firedRecurring.push(task);
        else firedOneShots.push(task.id);
      }
      if (firedRecurring.length > 0) {
        await markCronTasksFired(
          firedRecurring.map((t) => t.id),
          now,
          options.workspaceDir,
        );
      }
      if (firedOneShots.length > 0) {
        await removeCronTasks(firedOneShots, options.workspaceDir);
      }
    } finally {
      running = false;
    }
    arm();
  };

  const arm = (): void => {
    if (stopped) return;
    if (timer !== null) clock.clearTimer(timer);
    void (async () => {
      const now = clock.now().getTime();
      let earliest: number | null = null;
      for (const task of await deliveredTasks()) {
        const due = nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
        if (due === null) continue;
        if (earliest === null || due < earliest) earliest = due;
      }
      if (stopped) return;
      const sleep = Math.min(
        earliest === null ? CRON_DELIVERY_SCAN_CAP_MS : Math.max(0, earliest - now),
        CRON_DELIVERY_SCAN_CAP_MS,
      );
      timer = clock.setTimer(() => void tick(), sleep);
    })();
  };

  arm();
  log("cron: gateway delivery armed");

  return {
    isRunning: () => running,
    async stop() {
      stopped = true;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
    },
  };
}
