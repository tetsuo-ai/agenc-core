/**
 * `agenc gateway run` loop (TODO task 7).
 *
 * Wires the pieces built in task 6 into a running gateway:
 *   daemon client (SDK)  +  gateway config  +  channel adapters  →  ChannelGateway
 *
 * Adapters are selected by id from config + explicit flags. The stdio channel
 * is always available for local dev; Telegram activates when a bot token is
 * present. The loop runs until stopped (SIGINT/SIGTERM or the returned
 * handle's stop()).
 *
 * Security posture: the gateway opens NO listener of its own — it is a daemon
 * client. Telegram uses outbound long-poll. So there is no bind surface to
 * expose; the security audit's daemon checks still cover the daemon it
 * attaches to.
 */

import { ChannelGateway } from "./gateway.js";
import { loadGatewayConfig } from "./config.js";
import { createSdkDaemonClient } from "./sdk-daemon-client.js";
import { StdioChannelAdapter } from "./stdio-channel.js";
import {
  FetchTelegramTransport,
  TelegramChannelAdapter,
  TELEGRAM_CHANNEL_ID,
} from "./telegram-channel.js";
import type { ChannelAdapter, GatewayDaemonClient } from "./types.js";

export interface GatewayRunOptions {
  readonly agencHome: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Enable the stdio dev channel. */
  readonly stdio?: boolean;
  /** Telegram bot token; falls back to env AGENC_TELEGRAM_BOT_TOKEN. */
  readonly telegramToken?: string;
  readonly log?: (line: string) => void;
  /** Test seam: inject a daemon client instead of connecting via the SDK. */
  readonly clientFactory?: () => Promise<GatewayDaemonClient>;
  /** Test seam: extra adapters to register (e.g. a fake Telegram transport). */
  readonly extraAdapters?: readonly ChannelAdapter[];
  readonly agencCommand?: string;
}

export interface GatewayRunHandle {
  readonly gateway: ChannelGateway;
  readonly channels: readonly string[];
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
  const config = loadGatewayConfig({
    agencHome: options.agencHome,
    onWarn: log,
  });

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

  for (const adapter of options.extraAdapters ?? []) {
    adapters.push(adapter);
  }

  if (adapters.length === 0) {
    await client.close();
    throw new Error(
      "gateway run: no channels enabled — pass --stdio, set AGENC_TELEGRAM_BOT_TOKEN, or configure a channel",
    );
  }

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

  log(`gateway: running with channels: ${started.join(", ")}`);

  return {
    gateway,
    channels: started,
    async stop() {
      await gateway.stop();
      await client.close();
    },
  };
}
