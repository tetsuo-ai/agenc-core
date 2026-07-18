/**
 * Heartbeat ↔ gateway/budget integration (TODO task 14).
 *
 * Builds a live {@link HeartbeatScheduler} from the gateway's daemon client
 * (turn runner), its channel adapters (delivery), and the workspace
 * HEARTBEAT.md. The daemon execution-admission kernel owns spend accounting.
 * Returns null when heartbeat is disabled.
 *
 * The utility-model OVERRIDE (running heartbeat turns on a cheaper model) is
 * carried through `policy.model` to the turn runner, but applying it to the
 * live daemon turn needs a per-turn model seam the SDK does not yet expose.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import { isDaemonAgentGoneError } from "../gateway/sdk-daemon-client.js";
import type {
  ChannelAdapter,
  GatewayDaemonClient,
  GatewaySession,
} from "../gateway/types.js";
import { resolveHeartbeatPolicy } from "./config.js";
import { WorkspaceHeartbeatFileReader } from "./heartbeat-file.js";
import { HeartbeatRunner } from "./runner.js";
import { HeartbeatScheduler } from "./scheduler.js";
import type {
  HeartbeatClock,
  HeartbeatDelivery,
  HeartbeatTarget,
  HeartbeatTurnRunner,
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

const HEARTBEAT_SESSION_LABEL = "heartbeat";

/**
 * Session supplier for heartbeat turns: reuses one daemon session across
 * gateway restarts via a persisted id (`gateway/heartbeat-session`, 0600) so
 * each `gateway run` does not accumulate a fresh daemon agent, and
 * provisions a new one when the persisted session's agent is gone.
 */
function heartbeatSessionSupplier(options: {
  readonly agencHome: string;
  readonly client: GatewayDaemonClient;
}): { get(): Promise<GatewaySession>; invalidate(): void } {
  const path = join(options.agencHome, "gateway", "heartbeat-session");
  let live: GatewaySession | null = null;
  return {
    async get() {
      if (live !== null) return live;
      if (existsSync(path)) {
        const persistedId = readFileSync(path, "utf8").trim();
        if (persistedId.length > 0) {
          try {
            live = await options.client.attachSession(persistedId);
            return live;
          } catch {
            // Stale persisted id (daemon state pruned): fall through.
          }
        }
      }
      live = await options.client.createSession({
        label: HEARTBEAT_SESSION_LABEL,
      });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${live.sessionId}\n`, { mode: 0o600 });
      return live;
    },
    invalidate() {
      live = null;
      try {
        writeFileSync(path, "", { mode: 0o600 });
      } catch {
        // Best-effort: a stale id is re-detected on the next attach.
      }
    },
  };
}

/** A turn runner backed by a persistent gateway session (isolated heartbeat ctx). */
function gatewayTurnRunner(supplier: {
  get(): Promise<GatewaySession>;
  invalidate(): void;
}): HeartbeatTurnRunner {
  const runOnce = async (session: GatewaySession, prompt: string) => {
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
  };
  return {
    async run(prompt) {
      const session = await supplier.get();
      try {
        return await runOnce(session, prompt);
      } catch (error) {
        // Backing agent gone (daemon restart): reprovision and retry once.
        if (!isDaemonAgentGoneError(error)) throw error;
        supplier.invalidate();
        return await runOnce(await supplier.get(), prompt);
      }
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

  const runner = new HeartbeatRunner({
    policy,
    clock: options.clock ?? REAL_CLOCK,
    turnRunner: gatewayTurnRunner(
      heartbeatSessionSupplier({
        agencHome: options.agencHome,
        client: options.client,
      }),
    ),
    delivery: delivery(options.adapters),
    file: new WorkspaceHeartbeatFileReader(options.workspaceDir),
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
