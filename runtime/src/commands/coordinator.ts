import { join } from "node:path";
import { readStrictConfigLayer } from "../config/repository.js";
import { readCommandConfig } from "./config-context.js";
/**
 * `/coordinator` — first-class switch for coordinator mode (alias
 * `/fleet`).
 *
 * Coordinator mode swaps the main session onto the orchestration
 * surface: a coordinator system prompt plus a tool allowlist limited
 * to agent orchestration and user interaction (spawn_agent,
 * send_message, wait_agent, task tools — no file edits, no shell).
 * Both apply at session construction, so toggling takes effect on the
 * NEXT session; the command persists the `coordinator_mode` config
 * flag and reports how to apply it. Environment overrides are folded
 * into the ConfigStore snapshot once at session ingress.
 */
import { AgenCConfigEditsBuilder } from "../config/edit.js";
import {
  isCoordinatorModeEnabled,
  LIVE_COORDINATOR_ALLOWED_TOOLS,
} from "../coordinator/coordinatorMode.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

function statusText(configFlag: boolean | undefined, savedFlag: boolean | undefined): string {
  const effective = isCoordinatorModeEnabled(configFlag);
  return [
    `Coordinator mode: ${effective ? "ON" : "off"}`,
    `Config flag (coordinator_mode): ${configFlag === true ? "true" : configFlag === false ? "false" : "<unset>"}`,
    `Saved preference (coordinator_mode): ${savedFlag === undefined ? "<unset>" : String(savedFlag)}` ,
    effective
      ? `Active surface: ${LIVE_COORDINATOR_ALLOWED_TOOLS.join(", ")}`
      : "When on, the session becomes an orchestrator: coordinator prompt + orchestration-only tools (no file edits, no shell).",
    "Toggle with `/coordinator on` or `/coordinator off`; changes apply to the next session.",
  ].join("\n");
}

export const coordinatorCommand: SlashCommand = {
  name: "coordinator",
  aliases: ["fleet"],
  description: "Show or toggle coordinator (orchestrator) mode",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const arg = ctx.argsRaw.trim().toLowerCase();
      const configFlag = readCommandConfig(ctx)?.coordinator_mode ?? ctx.session.config?.coordinatorMode;
      if (arg === "") {
        const saved = ctx.agencHome === undefined
          ? undefined
          : (await readStrictConfigLayer(join(ctx.agencHome, "config.toml"), "user"))?.config.coordinator_mode;
        return { kind: "text", text: statusText(configFlag, saved) };
      }
      if (arg !== "on" && arg !== "off") {
        return {
          kind: "error",
          message: "usage: /coordinator [on|off]",
        };
      }
      const agencHome = ctx.agencHome;
      if (!agencHome) {
        return {
          kind: "error",
          message: "cannot persist coordinator_mode: AGENC_HOME is unknown",
        };
      }
      const enabled = arg === "on";
      await new AgenCConfigEditsBuilder(agencHome)
        .setCoordinatorMode(enabled)
        .apply();
      return {
        kind: "text",
        text: [
          `coordinator_mode = ${enabled} written to config.toml.`,
          "Restart the session (or start a new one) to apply. The coordinator prompt and tool allowlist bind at session construction.",
        ].join("\n"),
      };
    }),
};
