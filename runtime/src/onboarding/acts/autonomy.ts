/**
 * Onboarding Act 3 — guardrails, then autonomy (onboarding-plan-2026-07 O-5).
 *
 * HARD ORDER: budget → heartbeat → cron → webhooks. No step here enables an
 * autonomous surface before a spend envelope exists (or the user explicitly,
 * visibly picks "no cap"). Every sub-step is skippable and ends with the
 * live proof where one is possible.
 *
 * Config writes are append-only and conservative: a `[budget]`/`[heartbeat]`
 * section is appended to config.toml ONLY when absent; an existing section
 * is displayed with edit instructions — this wizard never rewrites TOML it
 * did not author. Cron jobs are written through the real task-file helpers;
 * hooks enablement goes through the gateway config's own JSON (merged, other
 * keys preserved).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../../config/loader.js";
import { resolveBudgetPolicy } from "../../budget/index.js";
import { resolveHeartbeatPolicy } from "../../heartbeat/config.js";
import {
  gatewayEnvFilePath,
  readGatewayEnvFile,
} from "../../gateway/env-file.js";
import { resolveGatewayConfigPath } from "../../gateway/config.js";
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
 * Append a TOML section iff no section with that header exists. Returns
 * false (and writes nothing) when the section is already present.
 */
export function appendTomlSectionIfAbsent(
  agencHome: string,
  header: string,
  lines: readonly string[],
): boolean {
  const path = configTomlPath(agencHome);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.includes(`[${header}]`)) return false;
  const block = [`\n[${header}]`, ...lines, ""].join("\n");
  writeFileSync(path, current.length > 0 ? `${current}${block}` : block.trimStart() + "\n");
  return true;
}

/** Merge a `hooks.enabled` flag into gateway/config.json, preserving keys. */
export function enableHooksInGatewayConfig(agencHome: string): void {
  const path = resolveGatewayConfigPath(agencHome);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable config would fail-closed everywhere else too; start over.
      raw = {};
    }
  }
  const hooks =
    raw.hooks !== null && typeof raw.hooks === "object"
      ? (raw.hooks as Record<string, unknown>)
      : {};
  raw.hooks = { ...hooks, enabled: true };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

export async function runAutonomyAct(
  options: AutonomyActOptions,
): Promise<number> {
  const { io, agencHome } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;

  io.say("");
  io.say("── Guardrails, then autonomy ────────────────────────────────");
  io.say("Order matters: the spend cap comes first. When a cap is hit,");
  io.say("autonomy pauses and tells you — never silently spends or stops.");

  // ── 1. Budget ─────────────────────────────────────────────────────────
  const { config } = await loadConfig({ home: agencHome, onWarn: io.say });
  const { policy: budget } = resolveBudgetPolicy(config.budget, env);
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
      const wrote = appendTomlSectionIfAbsent(agencHome, "budget", [
        "# Written by `agenc onboard autonomy` — daily cap for autonomous turns.",
        "enabled = true",
        `daily_usd = ${cap}`,
      ]);
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
  const heartbeat = resolveHeartbeatPolicy(config.heartbeat, env);
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
      const envEntries = readGatewayEnvFile(agencHome);
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
      const lines = [
        "# Written by `agenc onboard autonomy`.",
        "enabled = true",
        "interval_seconds = 1800",
      ];
      if (channel.length > 0 && conversation.length > 0) {
        lines.push(`target_channel = "${channel}"`);
        lines.push(`target_conversation = "${conversation}"`);
      }
      const wrote = appendTomlSectionIfAbsent(agencHome, "heartbeat", lines);
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
      enableHooksInGatewayConfig(agencHome);
      const token = resolveHooksToken(agencHome, env);
      io.say("Hooks enabled (loopback + bearer token; audit-checked).");
      io.say("Try it once the gateway is running:");
      io.say("");
      io.say(`  curl -s -X POST http://127.0.0.1:8377${HOOKS_PATH} \\`);
      io.say(`    -H "authorization: Bearer ${token}" \\`);
      io.say('    -H "content-type: application/json" \\');
      io.say('    -d \'{"message":"ping from my first webhook"}\'');
      io.say("");
      io.say(`(Token stored 0600 at ${gatewayEnvFilePath(agencHome).replace(/env$/, "hooks-token")}.)`);
    }
  }

  markOnboardingActComplete(agencHome, "autonomy");
  io.say("");
  io.say("Autonomy configured. Everything above only acts while the gateway");
  io.say("runs — keep it always-on with: agenc gateway install-service");
  return 0;
}
