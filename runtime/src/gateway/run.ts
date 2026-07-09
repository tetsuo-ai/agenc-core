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

import { ChannelGateway } from "./gateway.js";
import { loadGatewayConfig } from "./config.js";
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
    adapters.push(
      new TelegramChannelAdapter({
        transport: new FetchTelegramTransport({ token: telegramToken }),
        log,
      }),
    );
  }

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

  if (adapters.length === 0) {
    throw new Error(
      "gateway run: no channels enabled — pass --stdio, --webchat, set AGENC_TELEGRAM_BOT_TOKEN, or configure a channel",
    );
  }

  const client = await (options.clientFactory
    ? options.clientFactory()
    : createSdkDaemonClient({
        autostart: true,
        ...(options.agencCommand !== undefined
          ? { agencCommand: options.agencCommand }
          : {}),
      }));

  const gateway = new ChannelGateway({
    agencHome: options.agencHome,
    client,
    config,
    log,
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

  log(`gateway: running with channels: ${started.join(", ")}`);

  return {
    gateway,
    channels: started,
    ...(webchat !== undefined ? { webchatUrl: webchat.url } : {}),
    async stop() {
      await gateway.stop();
      await client.close();
    },
  };
}
