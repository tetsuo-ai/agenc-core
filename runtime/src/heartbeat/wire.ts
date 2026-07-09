/**
 * Heartbeat ↔ gateway/budget integration (TODO task 14).
 *
 * Builds a live {@link HeartbeatScheduler} from the gateway's daemon client
 * (turn runner), its channel adapters (delivery), the task-15 budget enforcer,
 * and the workspace HEARTBEAT.md. Returns null when heartbeat is disabled.
 *
 * The utility-model OVERRIDE (running heartbeat turns on a cheaper model) is
 * carried through `policy.model` to the turn runner, but applying it to the
 * live daemon turn needs a per-turn model seam the SDK does not yet expose —
 * that is the deferred cost-reduction tier (budget design §6). The budget CAP
 * is the safety boundary and is fully live regardless of which model runs.
 */

import type { AgenCConfig } from "../config/schema.js";
import {
  BudgetEnforcer,
  BudgetLedger,
  createModelPriceResolver,
  resolveBudgetPolicy,
} from "../budget/index.js";
import type { ChannelAdapter, GatewayDaemonClient } from "../gateway/types.js";
import { resolveHeartbeatPolicy } from "./config.js";
import { WorkspaceHeartbeatFileReader } from "./heartbeat-file.js";
import { HeartbeatRunner } from "./runner.js";
import { HeartbeatScheduler } from "./scheduler.js";
import type {
  HeartbeatBudgetGate,
  HeartbeatClock,
  HeartbeatDelivery,
  HeartbeatTarget,
  HeartbeatTurnRunner,
  HeartbeatUsage,
} from "./types.js";

const REAL_CLOCK: HeartbeatClock = {
  now: () => new Date(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
};

export interface StartHeartbeatOptions {
  readonly agencHome: string;
  readonly workspaceDir: string;
  readonly config: AgenCConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly client: GatewayDaemonClient;
  readonly adapters: readonly ChannelAdapter[];
  readonly log?: (line: string) => void;
  readonly isCronRunning?: () => boolean;
  /** Test seam: real timers by default. */
  readonly clock?: HeartbeatClock;
}

/** Adapt the task-15 BudgetEnforcer to the heartbeat's budget-gate seam. */
function budgetGate(
  enforcer: BudgetEnforcer,
): HeartbeatBudgetGate {
  return {
    admit(input) {
      const r = enforcer.admit({ ...input, autonomous: true });
      return r.ok
        ? { ok: true, hold: r.hold }
        : { ok: false, message: r.message };
    },
    reconcile(hold, usage: HeartbeatUsage) {
      // The hold is a BudgetHold; the enforcer validates its own shape.
      enforcer.reconcile(hold as never, usage);
    },
  };
}

/** A turn runner backed by a single gateway session (isolated heartbeat ctx). */
function gatewayTurnRunner(
  session: Awaited<ReturnType<GatewayDaemonClient["createSession"]>>,
): HeartbeatTurnRunner {
  return {
    async run(prompt) {
      const result = await session.prompt(prompt, {
        onEvent: () => {},
        // Autonomous, no human watching → deny permission requests (fail safe).
        onPermissionRequest: async () => ({
          behavior: "deny",
          reason: "heartbeat turns do not grant tool permissions",
        }),
      });
      return {
        finalMessage: result.finalMessage,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      };
    },
  };
}

function delivery(adapters: readonly ChannelAdapter[]): HeartbeatDelivery {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return {
    async deliver(target: HeartbeatTarget, text: string) {
      if (target.kind !== "channel") return;
      const adapter = byId.get(target.channelId);
      if (adapter === undefined) return;
      await adapter.send({ conversationId: target.conversationId, text });
    },
  };
}

export async function startHeartbeat(
  options: StartHeartbeatOptions,
): Promise<HeartbeatScheduler | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const policy = resolveHeartbeatPolicy(options.config.heartbeat, env);
  if (!policy.enabled) return null;

  // Budget enforcer (task 15). Disabled budget → the gate admits everything.
  const { policy: budgetPolicy } = resolveBudgetPolicy(options.config.budget, env);
  const enforcer = new BudgetEnforcer({
    policy: budgetPolicy,
    ledger: new BudgetLedger({ agencHome: options.agencHome }),
    priceOf: createModelPriceResolver(),
    notify: (e) => log(`heartbeat/budget: ${e.message}`),
  });

  const session = await options.client.createSession();
  const runner = new HeartbeatRunner({
    policy,
    clock: options.clock ?? REAL_CLOCK,
    turnRunner: gatewayTurnRunner(session),
    delivery: delivery(options.adapters),
    file: new WorkspaceHeartbeatFileReader(options.workspaceDir),
    budget: budgetGate(enforcer),
    ...(options.isCronRunning !== undefined
      ? { isCronRunning: options.isCronRunning }
      : {}),
    log,
  });

  const scheduler = new HeartbeatScheduler({
    intervalSeconds: policy.intervalSeconds,
    clock: options.clock ?? REAL_CLOCK,
    onTick: () => runner.tick(),
    onOutcome: (o) => {
      if (o.kind === "delivered") log("heartbeat: delivered a message");
      else if (o.kind === "budget_paused") log(`heartbeat: ${o.message}`);
      else if (o.kind === "error") log(`heartbeat error: ${o.message}`);
    },
  });
  scheduler.start();
  log(
    `heartbeat: running every ${policy.intervalSeconds}s` +
      (policy.target.kind === "channel"
        ? ` → ${policy.target.channelId}`
        : " (no delivery)"),
  );
  return scheduler;
}
