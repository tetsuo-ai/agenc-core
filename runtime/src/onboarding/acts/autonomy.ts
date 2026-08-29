/**
 * Onboarding Act 3 — guardrails, then autonomy (onboarding-plan-2026-07 O-5).
 *
 * HARD ORDER: budget → heartbeat → cron → webhooks. No step here enables an
 * autonomous surface before a spend envelope exists (or the user explicitly,
 * visibly picks "no cap"). Every sub-step is skippable and ends with the
 * live proof where one is possible.
 *
 * Canonical config writes are conservative: a `[budget]`/`[heartbeat]`
 * section is created ONLY when absent through the locked configuration
 * authority; an existing section is displayed with edit instructions. Cron
 * jobs are written through the real task-file helpers; hooks enablement uses
 * the same locked canonical config.toml authority.
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { JsonRecord } from "../../config/json.js";
import { loadCanonicalConfig } from "../../config/repository.js";
import { mutateCanonicalUserConfigSync } from "../../config/update-sync.js";
import { resolveBudgetPolicy } from "../../budget/index.js";
import { resolveHeartbeatPolicy } from "../../heartbeat/config.js";
import {
  readGatewayCredentialEnvironment,
} from "../../gateway/credentials.js";
import { resolveHooksToken } from "../../gateway/run.js";
import { HOOKS_PATH } from "../../gateway/hooks.js";
import {
  readCronTasks,
  writeCronTasks,
  nextCronRunMs,
  normalizeDelivery,
} from "../../utils/cronTasks.js";
import type { ActIO } from "./io.js";
import { markOnboardingActComplete, readOnboardingActs } from "./state.js";
import { captureSecureStorageIngress } from "../../utils/secureStorage/home.js";

export interface AutonomyActOptions {
  readonly agencHome: string;
  readonly io: ActIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: override Date.now for deterministic cron creation. */
  readonly now?: () => number;
}

function configTomlPath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

/**
 * Create one canonical config section iff it is absent. The shared updater
 * owns parsing, strict validation, schema versioning, locking, serialization,
 * and atomic installation. Returns false without rewriting an existing
 * section.
 */
export function setCanonicalConfigSectionIfAbsent(
  agencHome: string,
  header: string,
  value: Readonly<JsonRecord>,
): boolean {
  const path = configTomlPath(agencHome);
  let wrote = false;
  mutateCanonicalUserConfigSync(path, (raw) => {
    if (Object.hasOwn(raw, header)) return;
    raw[header] = { ...value };
    wrote = true;
  });
  return wrote;
}

/** Enable gateway hooks through the canonical locked config authority. */
export function enableHooksInCanonicalConfig(agencHome: string): void {
  mutateCanonicalUserConfigSync(configTomlPath(agencHome), (raw) => {
    const gateway =
      raw.gateway !== null &&
      typeof raw.gateway === "object" &&
      !Array.isArray(raw.gateway)
        ? (raw.gateway as JsonRecord)
        : {};
    const hooks =
      gateway.hooks !== null &&
      typeof gateway.hooks === "object" &&
      !Array.isArray(gateway.hooks)
        ? (gateway.hooks as JsonRecord)
        : {};
    raw.gateway = {
      ...gateway,
      hooks: { ...hooks, enabled: true },
    };
  });
}

export async function runAutonomyAct(
  options: AutonomyActOptions,
): Promise<number> {
  const { io, agencHome } = options;
  const ingress = captureSecureStorageIngress(
    options.env ?? process.env,
    agencHome,
  );
  const env = ingress.environment;
  const home = ingress.home;
  const now = options.now ?? Date.now;

  io.say("");
  io.say("── Guardrails, then autonomy ────────────────────────────────");
  io.say("Order matters: the spend cap comes first. When a cap is hit,");
  io.say("autonomy pauses and tells you — never silently spends or stops.");

  // ── 1. Budget ─────────────────────────────────────────────────────────
  const { config } = await loadCanonicalConfig({
    home: agencHome,
    env,
    onWarn: io.say,
  });
  const budget = resolveBudgetPolicy(config.budget);
  let hasCap = budget.enabled;
  if (budget.enabled) {
    io.say("");
    io.say("A budget envelope is already configured — keeping it.");
    io.say("(See `agenc budget status`; edit [budget] in config.toml.)");
  } else {
    io.say("");
    const capAnswer = await io.ask(
      "Daily autonomous spend cap in USD ('none' for no cap)",
      "2",
    );
    if (capAnswer.toLowerCase() === "none") {
      const sure = await io.confirm(
        "No cap means autonomous turns can spend without limit. Continue capless?",
        false,
      );
      if (!sure) return runAutonomyAct(options);
      io.say("Proceeding WITHOUT a cap — you chose this explicitly.");
    } else {
      const cap = Number.parseFloat(capAnswer);
      if (!Number.isFinite(cap) || cap <= 0) {
        io.say("That is not a positive number — try the act again.");
        return 1;
      }
      const wrote = setCanonicalConfigSectionIfAbsent(agencHome, "budget", {
        enabled: true,
        daily_usd: cap,
      });
      if (wrote) {
        io.say(`Cap set: $${cap}/day (config.toml [budget]).`);
        io.say("Check anytime with: agenc budget status");
        hasCap = true;
      } else {
        io.say(
          "config.toml already has a [budget] section this wizard will not rewrite — edit it directly.",
        );
      }
    }
  }

  // ── 2. Heartbeat ──────────────────────────────────────────────────────
  const heartbeat = resolveHeartbeatPolicy(config.heartbeat);
  io.say("");
  if (heartbeat.enabled) {
    io.say("Heartbeat already enabled — keeping your configuration.");
  } else if (
    await io.confirm(
      "Enable the heartbeat? (periodic check-ins driven by a HEARTBEAT.md you control)",
      false,
    )
  ) {
    if (!hasCap) {
      io.say("Refusing: set a budget cap first (autonomy needs guardrails).");
    } else {
      const acts = readOnboardingActs(agencHome);
      const defaultWs =
        acts.acts.identity?.detail?.workspace ??
        join(env.HOME ?? homedir(), "agent");
      const workspace = await io.ask(
        "Workspace holding HEARTBEAT.md",
        defaultWs,
      );
      const heartbeatPath = join(workspace, "HEARTBEAT.md");
      if (!existsSync(heartbeatPath)) {
        writeFileSync(
          heartbeatPath,
          [
            "# Heartbeat",
            "",
            "On each heartbeat, check for anything that needs my attention:",
            "- summarize notable changes in this workspace since the last check",
            "- flag anything that looks urgent",
            "",
            "If nothing needs attention, reply HEARTBEAT_OK.",
            "",
          ].join("\n"),
        );
        io.say(`Wrote a starter ${heartbeatPath} — edit it to change the job.`);
      }
      const envEntries = readGatewayCredentialEnvironment(home);
      const channelHint =
        envEntries.AGENC_TELEGRAM_BOT_TOKEN !== undefined
          ? "telegram"
          : envEntries.AGENC_DISCORD_BOT_TOKEN !== undefined
            ? "discord"
            : envEntries.AGENC_SLACK_BOT_TOKEN !== undefined
              ? "slack"
              : "";
      const channel = await io.ask(
        "Deliver heartbeat findings to which channel? (empty = none)",
        channelHint,
      );
      const conversation =
        channel.length > 0
          ? await io.ask(
              "Conversation id on that channel (your chat id — check `agenc gateway pairing list` after pairing)",
              "",
            )
          : "";
      const heartbeatConfig: JsonRecord = {
        enabled: true,
        interval_seconds: 1800,
      };
      if (channel.length > 0 && conversation.length > 0) {
        heartbeatConfig.target_channel = channel;
        heartbeatConfig.target_conversation = conversation;
      }
      const wrote = setCanonicalConfigSectionIfAbsent(
        agencHome,
        "heartbeat",
        heartbeatConfig,
      );
      io.say(
        wrote
          ? "Heartbeat configured (every 30 min while the gateway runs)."
          : "config.toml already has a [heartbeat] section — edit it directly.",
      );
      io.say("It ticks whenever `agenc gateway run` (or the service) is up.");
    }
  }

  // ── 3. Cron example ───────────────────────────────────────────────────
  io.say("");
  if (
    await io.confirm(
      "Add a scheduled job? (example: a 9am daily briefing delivered to your channel)",
      false,
    )
  ) {
    if (!hasCap) {
      io.say("Refusing: set a budget cap first.");
    } else {
      const acts = readOnboardingActs(agencHome);
      const workspace = await io.ask(
        "Workspace for the job file (.agenc/scheduled_tasks.json)",
        acts.acts.identity?.detail?.workspace ??
          join(env.HOME ?? homedir(), "agent"),
      );
      const schedule = await io.ask("Cron schedule", "0 9 * * *");
      if (nextCronRunMs(schedule, now()) === null) {
        io.say("That cron expression never fires — try the act again.");
        return 1;
      }
      const prompt = await io.ask(
        "What should it do?",
        "Give me a short morning briefing: anything new in this workspace, and my top follow-ups.",
      );
      const channel = await io.ask("Deliver to channel (empty = run in-session)", "");
      const to =
        channel.length > 0 ? await io.ask("Conversation id", "") : "";
      const deliver = normalizeDelivery({ channel, to });
      const tasks = await readCronTasks(workspace);
      tasks.push({
        id: randomUUID().slice(0, 8),
        cron: schedule,
        prompt,
        createdAt: now(),
        recurring: true,
        ...(deliver !== undefined ? { deliver } : {}),
      });
      await writeCronTasks(tasks, workspace);
      io.say(
        `Job saved (${schedule}). Delivery-routed jobs run under \`agenc gateway run\` from ${workspace}.`,
      );
    }
  }

  // ── 4. Webhooks ───────────────────────────────────────────────────────
  io.say("");
  if (
    await io.confirm(
      "Enable inbound webhooks? (POST /hooks/agent — trigger turns from CI, monitors, anything)",
      false,
    )
  ) {
    if (!hasCap) {
      io.say("Refusing: set a budget cap first.");
    } else {
      enableHooksInCanonicalConfig(agencHome);
      const token = resolveHooksToken(home, env);
      io.say("Hooks enabled (loopback + bearer token; audit-checked).");
      io.say("Try it once the gateway is running:");
      io.say("");
      io.say(`  curl -s -X POST http://127.0.0.1:8377${HOOKS_PATH} \\`);
      io.say(`    -H "authorization: Bearer ${token}" \\`);
      io.say('    -H "content-type: application/json" \\');
      io.say('    -d \'{"message":"ping from my first webhook"}\'');
      io.say("");
      io.say("(Token stored in the home-bound native secure storage.)");
    }
  }

  markOnboardingActComplete(agencHome, "autonomy");
  io.say("");
  io.say("Autonomy configured. Everything above only acts while the gateway");
  io.say("runs — keep it always-on with: agenc gateway install-service");
  return 0;
}
