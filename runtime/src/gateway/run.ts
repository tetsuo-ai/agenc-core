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
import { HooksServer } from "./hooks.js";
import { loadGatewayConfig } from "./config.js";
import {
  DISCORD_CHANNEL_ID,
  DiscordChannelAdapter,
  FetchDiscordTransport,
} from "./discord-channel.js";
import { SLACK_CHANNEL_ID } from "./slack-channel.js";
import {
  FetchSlackTransport,
  SlackChannelAdapter,
} from "./slack-channel.js";
import {
  HeliusOnchainFeature,
  loadHeliusGatewayApiKey,
  parseHeliusTokenAliases,
} from "./onchain.js";
import { createSdkDaemonClient } from "./sdk-daemon-client.js";
import { StdioChannelAdapter } from "./stdio-channel.js";
import {
  FetchTelegramTransport,
  TelegramChannelAdapter,
  TELEGRAM_CHANNEL_ID,
  type TelegramRichMessageMode,
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
  /** Discord bot token; falls back to env AGENC_DISCORD_BOT_TOKEN. */
  readonly discordToken?: string;
  /** Slack bot token (xoxb-); falls back to env AGENC_SLACK_BOT_TOKEN. */
  readonly slackBotToken?: string;
  /** Slack app-level token (xapp-, Socket Mode); falls back to env AGENC_SLACK_APP_TOKEN. */
  readonly slackAppToken?: string;
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
  /** Force the inbound-webhooks endpoint on for this run (else gateway config `hooks`). */
  readonly hooks?: boolean;
  readonly hooksHost?: string;
  readonly hooksPort?: number;
  readonly log?: (line: string) => void;
  /** Test seam: inject a daemon client instead of connecting via the SDK. */
  readonly clientFactory?: () => Promise<GatewayDaemonClient>;
  /** Test seam: extra adapters to register (e.g. a fake Telegram transport). */
  readonly extraAdapters?: readonly ChannelAdapter[];
  readonly agencCommand?: string;
}

export const GATEWAY_DIRECT_PROVIDER_ADMISSION_DIAGNOSTIC =
  "standalone gateway provider execution is disabled: it has no durable run/step admission, transactional budget reservation, or authoritative usage reconciliation; matching messages route through the daemon agent instead";

/**
 * Resolve a gateway surface token: env override, else a persisted per-home
 * token file (0600) so URLs/callers survive restarts, else generate+persist.
 */
function resolveGatewayToken(
  agencHome: string,
  fromEnv: string | undefined,
  fileName: string,
): string {
  const envToken = fromEnv?.trim();
  if (envToken !== undefined && envToken.length >= 16) return envToken;
  const path = join(agencHome, "gateway", fileName);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(join(agencHome, "gateway"), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

function resolveWebChatToken(
  agencHome: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return resolveGatewayToken(agencHome, env.AGENC_WEBCHAT_TOKEN, "webchat-token");
}

/** Persisted at gateway/hooks-token; AGENC_HOOKS_TOKEN overrides. */
export function resolveHooksToken(
  agencHome: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return resolveGatewayToken(agencHome, env.AGENC_HOOKS_TOKEN, "hooks-token");
}

/** On-disk hooks token file name (shared with the security audit). */
export const HOOKS_TOKEN_FILENAME = "hooks-token";

function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const GATEWAY_SECRET_ENV_NAMES = [
  "AGENC_GATEWAY_HELIUS_API_KEY",
  "AGENC_GATEWAY_HELIUS_KEY_FILE",
  "AGENC_TELEGRAM_BOT_TOKEN",
  "AGENC_TELEGRAM_OWNER_CLAIM_CODE",
  "AGENC_WEBCHAT_TOKEN",
  "AGENC_DISCORD_BOT_TOKEN",
  "AGENC_SLACK_BOT_TOKEN",
  "AGENC_SLACK_APP_TOKEN",
  "AGENC_HOOKS_TOKEN",
] as const;

/** Keep gateway transport/data credentials out of an autostarted agent daemon. */
export function sanitizeGatewayDaemonEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) sanitized[name] = value;
  }
  for (const name of GATEWAY_SECRET_ENV_NAMES) delete sanitized[name];
  return sanitized;
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

function envOptionalList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return envList(value);
}

function envPermissionMode(
  value: string | undefined,
):
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | undefined {
  if (
    value === "default" ||
    value === "plan" ||
    value === "acceptEdits" ||
    value === "bypassPermissions"
  ) {
    return value;
  }
  return undefined;
}

function envGroupAddressing(value: string | undefined): "all" | "mentions" {
  return value === "mentions" ? "mentions" : "all";
}

function envTelegramRichMessages(
  value: string | undefined,
): TelegramRichMessageMode {
  if (value === "all" || value === "off" || value === "private") return value;
  if (envFlag(value)) return "all";
  return "private";
}

export interface GatewayRunHandle {
  readonly gateway: ChannelGateway;
  readonly channels: readonly string[];
  /** Operator URL (with token) when WebChat is running. */
  readonly webchatUrl?: string;
  /** Bound port when the inbound-webhooks endpoint is running. */
  readonly hooksPort?: number;
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

  // Direct media/search helpers historically called provider endpoints from
  // the gateway process, outside the daemon's durable execution authority.
  // Keep their pure/injected classes testable, but production gateway startup
  // never installs them until they carry the same admission contract as an
  // ordinary daemon-routed turn.
  for (const [feature, requested] of [
    ["meme/image", envFlag(env.AGENC_GATEWAY_MEME_ENABLED)],
    ["voice/song", envFlag(env.AGENC_GATEWAY_VOICE_ENABLED)],
    ["X search", envFlag(env.AGENC_GATEWAY_X_SEARCH_ENABLED)],
  ] as const) {
    if (requested) {
      log(
        `gateway: ${feature} direct route fail-closed — ${GATEWAY_DIRECT_PROVIDER_ADMISSION_DIAGNOSTIC}`,
      );
    }
  }
  const telegramAdminPeerIds = envList(env.AGENC_TELEGRAM_ADMIN_PEER_IDS);
  const telegramOwnerClaimCode = env.AGENC_TELEGRAM_OWNER_CLAIM_CODE?.trim();
  const publicTelegramCommands: ReadonlyArray<{
    readonly command: string;
    readonly description: string;
  }> = [];
  const ownerTelegramCommands = [
    ...TELEGRAM_OWNER_COMMANDS,
    ...publicTelegramCommands,
  ];

  const telegramToken =
    options.telegramToken ?? env.AGENC_TELEGRAM_BOT_TOKEN?.trim();
  if (telegramToken !== undefined && telegramToken.length > 0) {
    const telegramTransport = new FetchTelegramTransport({ token: telegramToken });
    adapters.push(
      new TelegramChannelAdapter({
        transport: telegramTransport,
        commandMenus: [
          // Clear stale global private menus from older builds. Owner controls
          // are installed only on configured owner/admin chats below.
          { commands: [], scope: { type: "all_private_chats" } },
          // Replace the group menu every start so owner controls never appear
          // as public slash-command suggestions.
          {
            commands: publicTelegramCommands,
            scope: { type: "all_group_chats" },
          },
          ...telegramAdminPeerIds.map((peerId) => ({
            commands: ownerTelegramCommands,
            scope: { type: "chat", chat_id: peerId },
          })),
        ],
        groupAddressing: envGroupAddressing(
          env.AGENC_TELEGRAM_GROUP_ADDRESSING,
        ),
        debugUpdates: envFlag(env.AGENC_TELEGRAM_DEBUG_UPDATES),
        richMessages: envTelegramRichMessages(env.AGENC_TELEGRAM_RICH_MESSAGES),
        ...(env.AGENC_TELEGRAM_BOT_USERNAME !== undefined
          ? { botUsername: env.AGENC_TELEGRAM_BOT_USERNAME.trim() }
          : {}),
        log,
      }),
    );
  }

  // Discord (task 9): outbound Gateway WebSocket + REST — no listener.
  const discordToken =
    options.discordToken ?? env.AGENC_DISCORD_BOT_TOKEN?.trim();
  if (discordToken !== undefined && discordToken.length > 0) {
    adapters.push(
      new DiscordChannelAdapter({
        transport: new FetchDiscordTransport({ token: discordToken }),
        token: discordToken,
        groupAddressing:
          env.AGENC_DISCORD_GROUP_ADDRESSING === "all" ? "all" : "mentions",
        log,
      }),
    );
  }

  // Slack (task 9): Socket Mode (outbound WebSocket) + Web API — no
  // listener. Needs BOTH tokens: bot (xoxb-) for the Web API and app-level
  // (xapp-) for apps.connections.open.
  const slackBotToken =
    options.slackBotToken ?? env.AGENC_SLACK_BOT_TOKEN?.trim();
  const slackAppToken =
    options.slackAppToken ?? env.AGENC_SLACK_APP_TOKEN?.trim();
  if (
    slackBotToken !== undefined &&
    slackBotToken.length > 0 &&
    slackAppToken !== undefined &&
    slackAppToken.length > 0
  ) {
    adapters.push(
      new SlackChannelAdapter({
        transport: new FetchSlackTransport({
          botToken: slackBotToken,
          appToken: slackAppToken,
        }),
        groupAddressing:
          env.AGENC_SLACK_GROUP_ADDRESSING === "all" ? "all" : "mentions",
        log,
      }),
    );
  } else if (
    (slackBotToken !== undefined && slackBotToken.length > 0) !==
    (slackAppToken !== undefined && slackAppToken.length > 0)
  ) {
    log(
      "gateway: slack needs BOTH AGENC_SLACK_BOT_TOKEN (xoxb-) and AGENC_SLACK_APP_TOKEN (xapp-, Socket Mode) — channel not started",
    );
  }

  const heliusEnabled = envFlag(env.AGENC_GATEWAY_HELIUS_ENABLED);
  const heliusKey = loadHeliusGatewayApiKey({
    enabled: heliusEnabled,
    keyFile: env.AGENC_GATEWAY_HELIUS_KEY_FILE,
    inlineKey: env.AGENC_GATEWAY_HELIUS_API_KEY,
  });
  const heliusDailyLimit = envPositiveInt(
    env.AGENC_GATEWAY_HELIUS_DAILY_LIMIT,
  );
  const heliusPerPeerLimit = envPositiveInt(
    env.AGENC_GATEWAY_HELIUS_PER_PEER_LIMIT,
  );
  const heliusRequestsPerSecond = envPositiveInt(
    env.AGENC_GATEWAY_HELIUS_REQUESTS_PER_SECOND,
  );
  const heliusMaxTokenAccounts = envPositiveInt(
    env.AGENC_GATEWAY_HELIUS_MAX_TOKEN_ACCOUNTS,
  );
  const onchainFeature =
    heliusKey !== undefined
      ? new HeliusOnchainFeature({
          apiKey: heliusKey,
          usageFile: join(options.agencHome, "gateway", "helius-usage.json"),
          tokenAliases: parseHeliusTokenAliases(
            env.AGENC_GATEWAY_HELIUS_TOKEN_ALIASES,
          ),
          ...(heliusDailyLimit !== undefined
            ? { dailyLimit: heliusDailyLimit }
            : {}),
          ...(heliusPerPeerLimit !== undefined
            ? { perPeerLimit: heliusPerPeerLimit }
            : {}),
          ...(heliusRequestsPerSecond !== undefined
            ? { requestsPerSecond: heliusRequestsPerSecond }
            : {}),
          ...(heliusMaxTokenAccounts !== undefined
            ? { maxTokenAccountsScanned: heliusMaxTokenAccounts }
            : {}),
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

  // A heartbeat-only run (proactive ticks, no channel) is valid, and so is
  // a hooks-only run (the webhook endpoint is a trigger surface).
  const heartbeatRequested =
    options.heartbeat === true ||
    resolveHeartbeatPolicy(
      (await loadConfig({ home: options.agencHome, onWarn: log })).config
        .heartbeat,
      env,
    ).enabled;
  const hooksRequested =
    options.hooks === true || loaded.hooks?.enabled === true;
  if (adapters.length === 0 && !heartbeatRequested && !hooksRequested) {
    throw new Error(
      "gateway run: no channels enabled — pass --stdio, --webchat, --heartbeat, --hooks, set AGENC_TELEGRAM_BOT_TOKEN, or configure a channel",
    );
  }

  const client = await (options.clientFactory
    ? options.clientFactory()
    : createSdkDaemonClient({
        autostart: true,
        env: sanitizeGatewayDaemonEnv(env),
        // Gateway daemon agents work in the gateway's workspace so channel
        // turns and heartbeat ticks see the same files HEARTBEAT.md lives in.
        cwd: options.workspaceDir ?? process.cwd(),
        ...(options.agencCommand !== undefined
          ? { agencCommand: options.agencCommand }
          : {}),
        permissionMode: envPermissionMode(
          env.AGENC_GATEWAY_AGENT_PERMISSION_MODE,
        ),
        unattendedAllow:
          envOptionalList(env.AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW) ?? [
            "SendUserMessage",
            "Brief",
          ],
        unattendedDeny:
          envOptionalList(env.AGENC_GATEWAY_AGENT_UNATTENDED_DENY) ?? [],
      }));

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
    ...(onchainFeature !== undefined ? { onchainFeature } : {}),
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

  // Warn (do not block) when a networked channel has no policy: it inherits
  // the fail-closed pairing default, which is safe but surprising.
  for (const channelId of [
    TELEGRAM_CHANNEL_ID,
    DISCORD_CHANNEL_ID,
    SLACK_CHANNEL_ID,
  ]) {
    if (started.includes(channelId) && config.channels[channelId] === undefined) {
      log(
        `gateway: ${channelId} channel has no policy in gateway/config.json — using the pairing default (unknown senders must pair)`,
      );
    }
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

  // Inbound webhooks (task 17): disabled by default; enabled via the gateway
  // config `hooks` section or the --hooks flag. Loopback + bearer token; the
  // payload rides the task-11 untrusted framing and the task-15 budget.
  let hooksServer: HooksServer | null = null;
  const hooksConfig = config.hooks;
  if (options.hooks === true || hooksConfig?.enabled === true) {
    try {
      hooksServer = new HooksServer({
        agencHome: options.agencHome,
        token: resolveHooksToken(options.agencHome, env),
        client,
        adapters,
        config: mainConfigLoaded,
        env,
        defaultAgent: config.defaultAgent,
        ...(options.hooksHost !== undefined
          ? { host: options.hooksHost }
          : hooksConfig?.host !== undefined
            ? { host: hooksConfig.host }
            : {}),
        ...(options.hooksPort !== undefined
          ? { port: options.hooksPort }
          : hooksConfig?.port !== undefined
            ? { port: hooksConfig.port }
            : {}),
        ...(hooksConfig?.allowNonLoopback === true
          ? { allowNonLoopback: true }
          : {}),
        log,
      });
      await hooksServer.start();
    } catch (error) {
      hooksServer = null;
      log(`hooks: failed to start (continuing without them): ${String(error)}`);
    }
  }

  log(`gateway: running with channels: ${started.join(", ")}`);

  return {
    gateway,
    channels: started,
    ...(webchat !== undefined ? { webchatUrl: webchat.url } : {}),
    ...(hooksServer !== null ? { hooksPort: hooksServer.port } : {}),
    async stop() {
      if (hooksServer !== null) await hooksServer.stop();
      if (heartbeat !== null) await heartbeat.stop();
      if (cronDelivery !== null) await cronDelivery.stop();
      await gateway.stop();
      await client.close();
    },
  };
}
