/**
 * Onboarding posture recap + what-now card (onboarding-plan-2026-07 O-6).
 *
 * One screen that answers "what did I just open, and is it safe?": the
 * security audit result plus a per-surface posture summary, then five
 * starter prompts. Also powers the extended `agenc onboard --status`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../../config/loader.js";
import { resolveBudgetPolicy } from "../../budget/index.js";
import { resolveHeartbeatPolicy } from "../../heartbeat/config.js";
import { loadGatewayConfig } from "../../gateway/config.js";
import { readGatewayEnvFile } from "../../gateway/env-file.js";
import {
  buildSecurityAuditReport,
  securityAuditExitCode,
  type SecurityAuditReport,
} from "../../bin/security-cli.js";
import { readOnboardingActs, type OnboardingActsState } from "./state.js";
import type { ActIO } from "./io.js";

export interface OnboardingSurfaceSummary {
  readonly acts: OnboardingActsState;
  readonly personaWorkspace?: string;
  readonly personaFiles: readonly string[];
  readonly channels: readonly string[];
  readonly hooksEnabled: boolean;
  readonly budgetEnabled: boolean;
  readonly heartbeatEnabled: boolean;
}

export async function buildOnboardingSurfaceSummary(
  agencHome: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OnboardingSurfaceSummary> {
  const acts = readOnboardingActs(agencHome);
  const workspace = acts.acts.identity?.detail?.workspace;
  const personaFiles: string[] = [];
  if (workspace !== undefined) {
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      if (existsSync(join(workspace, name))) personaFiles.push(name);
    }
  }
  const gatewayEnv = readGatewayEnvFile(agencHome);
  const channels: string[] = [];
  if (gatewayEnv.AGENC_TELEGRAM_BOT_TOKEN !== undefined) channels.push("telegram");
  if (gatewayEnv.AGENC_DISCORD_BOT_TOKEN !== undefined) channels.push("discord");
  if (
    gatewayEnv.AGENC_SLACK_BOT_TOKEN !== undefined &&
    gatewayEnv.AGENC_SLACK_APP_TOKEN !== undefined
  ) {
    channels.push("slack");
  }
  const gatewayConfig = loadGatewayConfig({ agencHome });
  const { config } = await loadConfig({ home: agencHome, onWarn: () => {} });
  return {
    acts,
    ...(workspace !== undefined ? { personaWorkspace: workspace } : {}),
    personaFiles,
    channels,
    hooksEnabled: gatewayConfig.hooks?.enabled === true,
    budgetEnabled: resolveBudgetPolicy(config.budget, env).policy.enabled,
    heartbeatEnabled: resolveHeartbeatPolicy(config.heartbeat, env).enabled,
  };
}

const STARTER_PROMPTS = [
  '"summarize this repository and suggest one improvement"',
  '"watch for TODOs in this project and keep a running list in NOTES.md"',
  "(from your phone) \"what's on my plate today?\"",
  '"schedule a 9am briefing of anything that changed overnight"',
  "(from a script) curl your /hooks/agent endpoint with a deploy report",
] as const;

export async function runRecap(options: {
  readonly agencHome: string;
  readonly io: ActIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam. */
  readonly buildAuditReport?: () => Promise<SecurityAuditReport>;
}): Promise<number> {
  const { io, agencHome } = options;
  const env = options.env ?? process.env;
  const summary = await buildOnboardingSurfaceSummary(agencHome, env);
  const report = await (options.buildAuditReport?.() ??
    buildSecurityAuditReport({ env }));

  io.say("");
  io.say("── Your agent, at a glance ──────────────────────────────────");
  io.say(
    `  Identity:   ${
      summary.personaWorkspace !== undefined
        ? `${summary.personaWorkspace} (${summary.personaFiles.join(", ") || "no persona files yet"})`
        : "not set up — agenc onboard identity"
    }`,
  );
  io.say(
    `  Channels:   ${
      summary.channels.length > 0
        ? `${summary.channels.join(", ")} (pairing-gated)`
        : "none — agenc onboard channel"
    }`,
  );
  io.say(
    `  Budget:     ${summary.budgetEnabled ? "capped (agenc budget status)" : "no cap set"}`,
  );
  io.say(
    `  Heartbeat:  ${summary.heartbeatEnabled ? "enabled (while the gateway runs)" : "off"}`,
  );
  io.say(
    `  Webhooks:   ${summary.hooksEnabled ? "enabled (loopback + bearer token)" : "off"}`,
  );
  io.say("");

  const critical = report.criticalCount;
  if (securityAuditExitCode(report) === 0) {
    io.say("  Security audit: all checks passed.");
  } else {
    io.say(`  Security audit: ${critical} critical finding(s) — details:`);
    for (const finding of report.findings) {
      if (finding.severity === "critical") {
        io.say(`    ✗ ${finding.title}`);
        if (finding.remediation !== undefined) {
          io.say(`      fix: ${finding.remediation}`);
        }
      }
    }
  }

  io.say("");
  io.say("Things to try:");
  for (const prompt of STARTER_PROMPTS) io.say(`  · ${prompt}`);
  io.say("");
  io.say("Any act re-runs any time: agenc onboard identity|channel|autonomy");
  return securityAuditExitCode(report) === 0 ? 0 : 1;
}
