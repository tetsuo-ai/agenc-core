/**
 * Onboarding Act 2b — "take it with you" (onboarding-plan-2026-07 O-3).
 *
 * Guided channel setup: pick a surface, acquire + LIVE-VALIDATE the token,
 * store it in the sanitized gateway env file (0600 — never in config.json),
 * explain the pairing default in one sentence, then run the live smoke: the
 * gateway starts in-process, the user messages their bot from their phone,
 * pairs with the code, and sees the agent answer before the act completes.
 *
 * Security posture is narrated, never weakened: tokens are validated before
 * anything persists, secrets live in `<agencHome>/gateway/env` (loaded by
 * `agenc gateway run` and the service unit, stripped from daemon autostart
 * env), and unknown senders stay pairing-gated.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FetchDiscordTransport } from "../../gateway/discord-channel.js";
import {
  gatewayEnvFilePath,
  readGatewayEnvFile,
  writeGatewayEnvEntries,
} from "../../gateway/env-file.js";
import { FetchSlackTransport } from "../../gateway/slack-channel.js";
import { FetchTelegramTransport } from "../../gateway/telegram-channel.js";
import {
  startGateway,
  type GatewayRunHandle,
  type GatewayRunOptions,
} from "../../gateway/run.js";
import type { ActIO } from "./io.js";
import { markOnboardingActComplete } from "./state.js";

export interface ChannelValidators {
  telegram(token: string): Promise<{ ok: boolean; detail?: string }>;
  discord(token: string): Promise<{ ok: boolean; detail?: string }>;
  slack(
    botToken: string,
    appToken: string,
  ): Promise<{ ok: boolean; detail?: string }>;
}

export interface ChannelActOptions {
  readonly agencHome: string;
  readonly io: ActIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seams. */
  readonly validators?: ChannelValidators;
  readonly startGatewayFn?: (
    options: GatewayRunOptions,
  ) => Promise<GatewayRunHandle>;
  readonly pairingPollIntervalMs?: number;
  readonly pairingTimeoutMs?: number;
}

const DEFAULT_VALIDATORS: ChannelValidators = {
  async telegram(token) {
    try {
      const transport = new FetchTelegramTransport({ token });
      const me = await transport.getMe?.();
      return me !== undefined && me !== null
        ? { ok: true, detail: `@${me.username ?? "bot"}` }
        : { ok: false, detail: "getMe returned nothing" };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  },
  async discord(token) {
    try {
      await new FetchDiscordTransport({ token }).getGatewayUrl();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  },
  async slack(botToken, appToken) {
    try {
      const transport = new FetchSlackTransport({ botToken, appToken });
      const auth = await transport.authTest();
      await transport.openSocketUrl();
      return { ok: true, detail: `bot user ${auth.userId}` };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  },
};

function readPairedPeers(agencHome: string, channelId: string): string[] {
  try {
    const raw = JSON.parse(
      readFileSync(join(agencHome, "gateway", "pairing.json"), "utf8"),
    ) as { paired?: Record<string, string[]> };
    return raw.paired?.[channelId] ?? [];
  } catch {
    return [];
  }
}

const CHANNEL_GUIDES: Readonly<Record<string, readonly string[]>> = {
  telegram: [
    "Telegram setup (about 2 minutes):",
    "  1. Open Telegram and message @BotFather",
    "  2. Send /newbot and follow the prompts (pick any name + username)",
    "  3. BotFather replies with a token like 110201543:AAHdqTcv…",
  ],
  discord: [
    "Discord setup:",
    "  1. https://discord.com/developers/applications → New Application",
    "  2. Bot tab → Reset Token → copy it",
    "  3. IMPORTANT: on the same Bot tab, enable the 'MESSAGE CONTENT'",
    "     privileged intent — without it your bot sees empty messages.",
    "  4. OAuth2 → URL Generator → scope 'bot' → open the URL to invite it",
  ],
  slack: [
    "Slack setup (Socket Mode — no public URL needed):",
    "  1. https://api.slack.com/apps → Create App (from scratch)",
    "  2. Socket Mode: enable it; create an app-level token (xapp-…)",
    "     with the connections:write scope",
    "  3. OAuth & Permissions: add bot scopes chat:write + app_mentions:read",
    "     + im:history + channels:history, then Install to Workspace (xoxb-…)",
    "  4. Event Subscriptions: enable; subscribe the bot to message.im,",
    "     message.channels, and app_mention",
  ],
};

export async function runChannelAct(
  options: ChannelActOptions,
): Promise<number> {
  const { io, agencHome } = options;
  const env = options.env ?? process.env;
  const validators = options.validators ?? DEFAULT_VALIDATORS;
  const start = options.startGatewayFn ?? startGateway;

  io.say("");
  io.say("── Take your agent with you ─────────────────────────────────");
  io.say("Connect a messaging surface. Everything stays fail-closed:");
  io.say("strangers who find your bot get a pairing code, not your agent.");
  io.say("");

  const channel = await io.select("Which surface first?", [
    { key: "telegram", label: "Telegram", hint: "recommended — 2-minute setup" },
    { key: "discord", label: "Discord" },
    { key: "slack", label: "Slack", hint: "Socket Mode, no public URL" },
    { key: "webchat", label: "WebChat", hint: "no account needed — a local URL" },
  ]);

  const entries: Record<string, string> = {};
  if (channel !== "webchat") {
    for (const line of CHANNEL_GUIDES[channel] ?? []) io.say(line);
    io.say("");
  }

  if (channel === "telegram") {
    for (;;) {
      const token = await io.askSecret("Paste your bot token");
      const check = await validators.telegram(token);
      if (check.ok) {
        io.say(`Token verified${check.detail !== undefined ? ` (${check.detail})` : ""}.`);
        entries.AGENC_TELEGRAM_BOT_TOKEN = token;
        break;
      }
      io.say(`That token did not verify: ${check.detail ?? "unknown error"}`);
      if (!(await io.confirm("Try again?", true))) return 1;
    }
  } else if (channel === "discord") {
    for (;;) {
      const token = await io.askSecret("Paste your bot token");
      const check = await validators.discord(token);
      if (check.ok) {
        io.say("Token verified.");
        entries.AGENC_DISCORD_BOT_TOKEN = token;
        break;
      }
      io.say(`That token did not verify: ${check.detail ?? "unknown error"}`);
      io.say("(A valid token that still fails later usually means the");
      io.say(" MESSAGE CONTENT intent toggle was missed — see step 3.)");
      if (!(await io.confirm("Try again?", true))) return 1;
    }
  } else if (channel === "slack") {
    for (;;) {
      const botToken = await io.askSecret("Paste the bot token (xoxb-…)");
      const appToken = await io.askSecret("Paste the app-level token (xapp-…)");
      const check = await validators.slack(botToken, appToken);
      if (check.ok) {
        io.say(`Tokens verified${check.detail !== undefined ? ` (${check.detail})` : ""}.`);
        entries.AGENC_SLACK_BOT_TOKEN = botToken;
        entries.AGENC_SLACK_APP_TOKEN = appToken;
        break;
      }
      io.say(`Those tokens did not verify: ${check.detail ?? "unknown error"}`);
      if (!(await io.confirm("Try again?", true))) return 1;
    }
  }

  if (Object.keys(entries).length > 0) {
    writeGatewayEnvEntries(agencHome, entries);
    io.say(`Stored (0600) in ${gatewayEnvFilePath(agencHome)} — picked up by`);
    io.say("`agenc gateway run` and the gateway service, never by the daemon.");
  }

  io.say("");
  io.say("Policy: pairing (the default). Unknown senders get a one-time");
  io.say("code; you approve them here. Nothing to configure.");

  // ── The live smoke IS the step ────────────────────────────────────────
  io.say("");
  const smoke = await io.confirm(
    "Start the gateway now and pair your first device?",
    true,
  );
  if (smoke) {
    // Snapshot BEFORE the gateway starts: a pairing can land immediately.
    const before = new Set(readPairedPeers(agencHome, channel));
    let handle: GatewayRunHandle | null = null;
    try {
      handle = await start({
        agencHome,
        env: { ...env, ...readGatewayEnvFile(agencHome) },
        webchat: channel === "webchat",
        log: (line) => io.say(`  ${line}`),
      });
      if (channel === "webchat") {
        io.say("");
        io.say(`Open this in your browser: ${handle.webchatUrl ?? "(no url?)"}`);
        io.say("Send a message there — the token in the URL is your auth.");
        const replied = await io.confirm("Did the agent reply?", true);
        io.say(replied ? "Channel live." : "See the log lines above for what happened.");
      } else {
        io.say("");
        io.say(`Now message your bot on ${channel} from your phone.`);
        io.say("It will reply with a pairing code; the code also shows here.");
        const timeoutAt =
          Date.now() + (options.pairingTimeoutMs ?? 5 * 60 * 1000);
        const interval = options.pairingPollIntervalMs ?? 2000;
        io.say("Waiting for you to pair (reply to the bot with the code)…");
        let paired: string | null = null;
        while (Date.now() < timeoutAt) {
          const now = readPairedPeers(agencHome, channel).filter(
            (peer) => !before.has(peer),
          );
          if (now.length > 0) {
            paired = now[0];
            break;
          }
          await new Promise((r) => setTimeout(r, interval));
        }
        if (paired !== null) {
          io.say(`Paired: ${paired}. Send one more message to your bot.`);
          const replied = await io.confirm("Did the agent reply?", true);
          io.say(
            replied
              ? "Channel live — your agent answers on your phone now."
              : "Check the log lines above; `agenc gateway status` also helps.",
          );
        } else {
          io.say("No pairing seen yet — that's fine. The gateway keeps the");
          io.say("same behavior whenever you run it; pair any time.");
        }
      }
    } catch (error) {
      io.say(`Gateway failed to start: ${String(error)}`);
      io.say("Fix the issue and re-run: agenc onboard channel");
      return 1;
    } finally {
      await handle?.stop();
    }
    io.say("");
    io.say("The gateway stopped with this wizard. Keep it always-on with:");
    io.say("  agenc gateway install-service     (recommended)");
    io.say("or run it manually:  agenc gateway run");
  } else {
    io.say("Skipped. Run the gateway any time with: agenc gateway run");
  }

  markOnboardingActComplete(agencHome, "channel", { channel });
  return 0;
}
