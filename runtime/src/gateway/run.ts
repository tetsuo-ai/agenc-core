/**
 * `agenc gateway run` loop (TODO task 7-8).
 *
 * Wires the pieces built in task 6 into a running gateway:
 *   daemon client (SDK)  +  gateway config  +  channel adapters  →  ChannelGateway
 *
 * Adapters are selected by id from config + explicit flags: stdio dev channel
 * (`--stdio`), Telegram (bot token present), WebChat (`--webchat`, a local
 * token-gated browser surface). The loop runs until stopped.
 *
 * Security posture: stdio and Telegram open NO listener (Telegram is outbound
 * long-poll). WebChat DOES open a listener — it binds loopback and refuses a
 * non-loopback host without an explicit override, and every request is token-
 * gated. So the only bind surface is loopback + token-authenticated.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config/loader.js";
import { resolveHeartbeatPolicy } from "../heartbeat/config.js";
import { startHeartbeat } from "../heartbeat/wire.js";
import type { HeartbeatScheduler } from "../heartbeat/scheduler.js";
import { startCronDelivery, type CronDeliveryHandle } from "./cron-delivery.js";
import {
  TELEGRAM_OWNER_COMMANDS,
  TelegramOwnerControl,
} from "./control-plane.js";
import { ChannelGateway } from "./gateway.js";
import { loadGatewayConfig } from "./config.js";
import { XaiMemeFeature } from "./meme.js";
import { createSdkDaemonClient } from "./sdk-daemon-client.js";
import { StdioChannelAdapter } from "./stdio-channel.js";
import {
  FetchTelegramTransport,
  TelegramChannelAdapter,
  TELEGRAM_CHANNEL_ID,
} from "./telegram-channel.js";
import {
  WebChatChannelAdapter,
  WEBCHAT_CHANNEL_ID,
  WEBCHAT_PEER_ID,
} from "./webchat-channel.js";
import type {
  ChannelAdapter,
  GatewayChannelPolicy,
  GatewayConfig,
  GatewayDaemonClient,
} from "./types.js";

export interface GatewayRunOptions {
  readonly agencHome: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Enable the stdio dev channel. */
  readonly stdio?: boolean;
  /** Telegram bot token; falls back to env AGENC_TELEGRAM_BOT_TOKEN. */
  readonly telegramToken?: string;
  /** Enable the WebChat browser surface (loopback + token). */
  readonly webchat?: boolean;
  /** Force the proactive heartbeat on for this run (else [heartbeat] config). */
  readonly heartbeat?: boolean;
  /** Workspace dir for HEARTBEAT.md (default process.cwd()). */
  readonly workspaceDir?: string;
  /** Test seam: inject the heartbeat clock (real timers by default). */
  readonly heartbeatClock?: import("../heartbeat/types.js").HeartbeatClock;
  /** Test seam: inject the cron-delivery clock (real timers by default). */
  readonly cronClock?: import("./cron-delivery.js").CronDeliveryClock;
  /** WebChat bind host (default 127.0.0.1) / port (default ephemeral). */
  readonly webchatHost?: string;
  readonly webchatPort?: number;
  readonly webchatAllowNonLoopback?: boolean;
  readonly log?: (line: string) => void;
  /** Test seam: inject a daemon client instead of connecting via the SDK. */
  readonly clientFactory?: () => Promise<GatewayDaemonClient>;
  /** Test seam: extra adapters to register (e.g. a fake Telegram transport). */
  readonly extraAdapters?: readonly ChannelAdapter[];
  readonly agencCommand?: string;
}

/**
 * Resolve the WebChat token: env override, else a persisted per-home token
 * (0600) so the browser URL survives restarts, else generate + persist.
 */
function resolveWebChatToken(
  agencHome: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const fromEnv = env.AGENC_WEBCHAT_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length >= 16) return fromEnv;
  const path = join(agencHome, "gateway", "webchat-token");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(join(agencHome, "gateway"), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface GatewayRunHandle {
  readonly gateway: ChannelGateway;
  readonly channels: readonly string[];
  /** Operator URL (with token) when WebChat is running. */
  readonly webchatUrl?: string;
  stop(): Promise<void>;
}

/**
 * Build and start the gateway. Returns a handle; the caller decides how long
 * to run (the CLI waits on signals). Throws if no channel could be started.
 */
export async function startGateway(
  options: GatewayRunOptions,
): Promise<GatewayRunHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const loaded = loadGatewayConfig({
    agencHome: options.agencHome,
    onWarn: log,
  });

  const adapters: ChannelAdapter[] = [];
  if (options.stdio === true) {
    adapters.push(new StdioChannelAdapter());
  }

  const telegramToken =
    options.telegramToken ?? env.AGENC_TELEGRAM_BOT_TOKEN?.trim();
  if (telegramToken !== undefined && telegramToken.length > 0) {
    const telegramTransport = new FetchTelegramTransport({ token: telegramToken });
    adapters.push(
      new TelegramChannelAdapter({
        transport: telegramTransport,
        commands: TELEGRAM_OWNER_COMMANDS,
        log,
      }),
    );
  }

  const xaiKey = env.XAI_API_KEY?.trim();
  const memeDailyLimit = envPositiveInt(env.AGENC_GATEWAY_MEME_DAILY_LIMIT);
  const memeFeature =
    envFlag(env.AGENC_GATEWAY_MEME_ENABLED) &&
    xaiKey !== undefined &&
    xaiKey.length > 0
      ? new XaiMemeFeature({
          apiKey: xaiKey,
          usageFile: join(options.agencHome, "gateway", "meme-usage.json"),
          ...(env.AGENC_GATEWAY_MEME_MODEL !== undefined
            ? { model: env.AGENC_GATEWAY_MEME_MODEL }
            : {}),
          ...(memeDailyLimit !== undefined ? { dailyLimit: memeDailyLimit } : {}),
          log,
        })
      : undefined;

  // WebChat: the loopback bind + shared token IS the auth, so unless the
  // operator explicitly configured a policy, the web sender is allowlisted
  // (no point pairing with your own browser after presenting the token).
  let config: GatewayConfig = loaded;
  let webchat: WebChatChannelAdapter | undefined;
  if (options.webchat === true) {
    const token = resolveWebChatToken(options.agencHome, env);
    webchat = new WebChatChannelAdapter({
      token,
      ...(options.webchatHost !== undefined ? { host: options.webchatHost } : {}),
      ...(options.webchatPort !== undefined ? { port: options.webchatPort } : {}),
      ...(options.webchatAllowNonLoopback !== undefined
        ? { allowNonLoopback: options.webchatAllowNonLoopback }
        : {}),
      log,
    });
    adapters.push(webchat);
    if (config.channels[WEBCHAT_CHANNEL_ID] === undefined) {
      const webchatPolicy: GatewayChannelPolicy = {
        dmPolicy: "allowlist",
        allowlist: [WEBCHAT_PEER_ID],
      };
      config = {
        ...config,
        channels: { ...config.channels, [WEBCHAT_CHANNEL_ID]: webchatPolicy },
      };
    }
  }

  for (const adapter of options.extraAdapters ?? []) {
    adapters.push(adapter);
  }

  // A heartbeat-only run (proactive ticks, no channel) is valid.
  const heartbeatRequested =
    options.heartbeat === true ||
    resolveHeartbeatPolicy(
      (await loadConfig({ home: options.agencHome, onWarn: log })).config
        .heartbeat,
      env,
    ).enabled;
  if (adapters.length === 0 && !heartbeatRequested) {
    throw new Error(
      "gateway run: no channels enabled — pass --stdio, --webchat, --heartbeat, set AGENC_TELEGRAM_BOT_TOKEN, or configure a channel",
    );
  }

  const client = await (options.clientFactory
    ? options.clientFactory()
    : createSdkDaemonClient({
        autostart: true,
        // Gateway daemon agents work in the gateway's workspace so channel
        // turns and heartbeat ticks see the same files HEARTBEAT.md lives in.
        cwd: options.workspaceDir ?? process.cwd(),
        ...(options.agencCommand !== undefined
          ? { agencCommand: options.agencCommand }
          : {}),
      }));

  const telegramAdminPeerIds = envList(env.AGENC_TELEGRAM_ADMIN_PEER_IDS);
  const telegramOwnerClaimCode = env.AGENC_TELEGRAM_OWNER_CLAIM_CODE?.trim();
  const controlPlane =
    telegramAdminPeerIds.length > 0 ||
    (telegramOwnerClaimCode !== undefined && telegramOwnerClaimCode.length > 0)
      ? new TelegramOwnerControl({
          agencHome: options.agencHome,
          adminPeerIds: telegramAdminPeerIds,
          ...(telegramOwnerClaimCode !== undefined &&
          telegramOwnerClaimCode.length > 0
            ? { ownerClaimCode: telegramOwnerClaimCode }
            : {}),
          log,
        })
      : undefined;

  const gateway = new ChannelGateway({
    agencHome: options.agencHome,
    client,
    config,
    log,
    ...(memeFeature !== undefined ? { memeFeature } : {}),
    ...(controlPlane !== undefined ? { controlPlane } : {}),
  });

  const started: string[] = [];
  try {
    for (const adapter of adapters) {
      await gateway.registerAdapter(adapter);
      started.push(adapter.id);
    }
  } catch (error) {
    await gateway.stop();
    await client.close();
    throw error;
  }

  // Warn (do not block) if Telegram is enabled but its channel has no policy:
  // it inherits the fail-closed pairing default, which is safe but surprising.
  if (
    started.includes(TELEGRAM_CHANNEL_ID) &&
    config.channels[TELEGRAM_CHANNEL_ID] === undefined
  ) {
    log(
      "gateway: telegram channel has no policy in gateway/config.json — using the pairing default (unknown senders must pair)",
    );
  }

  if (webchat !== undefined && started.includes(WEBCHAT_CHANNEL_ID)) {
    log(`gateway: WebChat on ${webchat.url}`);
  }

  // Cron delivery (task 16): delivery-tagged cron tasks run in isolated
  // gateway sessions and announce to channels / POST to webhooks. Restart
  // re-arms from the persisted .agenc/scheduled_tasks.json.
  let cronDelivery: CronDeliveryHandle | null = null;
  const mainConfigLoaded = (
    await loadConfig({ home: options.agencHome, onWarn: log })
  ).config;
  try {
    cronDelivery = startCronDelivery({
      agencHome: options.agencHome,
      workspaceDir: options.workspaceDir ?? process.cwd(),
      config: mainConfigLoaded,
      env,
      client,
      adapters,
      log,
      ...(options.cronClock !== undefined ? { clock: options.cronClock } : {}),
    });
  } catch (error) {
    log(`cron: failed to start delivery (continuing without it): ${String(error)}`);
  }

  // Heartbeat (task 14): proactive autonomous ticks, bounded by the budget
  // layer. Enabled via [heartbeat] config or AGENC_HEARTBEAT; --heartbeat
  // forces it on for this run. Uses the same daemon client + channel adapters.
  let heartbeat: HeartbeatScheduler | null = null;
  try {
    const heartbeatConfig =
      options.heartbeat === true
        ? {
            ...mainConfigLoaded,
            heartbeat: { ...mainConfigLoaded.heartbeat, enabled: true },
          }
        : mainConfigLoaded;
    heartbeat = await startHeartbeat({
      agencHome: options.agencHome,
      workspaceDir: options.workspaceDir ?? process.cwd(),
      config: heartbeatConfig,
      env,
      client,
      adapters,
      log,
      // skip-when-busy: a heartbeat tick defers while a cron delivery turn
      // is in flight (both are autonomous turns on the same daemon).
      isCronRunning: () => cronDelivery?.isRunning() === true,
      ...(options.heartbeatClock !== undefined
        ? { clock: options.heartbeatClock }
        : {}),
    });
  } catch (error) {
    log(`heartbeat: failed to start (continuing without it): ${String(error)}`);
  }

  log(`gateway: running with channels: ${started.join(", ")}`);

  return {
    gateway,
    channels: started,
    ...(webchat !== undefined ? { webchatUrl: webchat.url } : {}),
    async stop() {
      if (heartbeat !== null) await heartbeat.stop();
      if (cronDelivery !== null) await cronDelivery.stop();
      await gateway.stop();
      await client.close();
    },
  };
}
