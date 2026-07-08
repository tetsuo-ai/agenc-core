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
 * flag and reports how to apply it. `AGENC_COORDINATOR_MODE` env
 * remains an override in both directions.
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

function statusText(configFlag: boolean | undefined): string {
  const effective = isCoordinatorModeEnabled(configFlag);
  const envRaw = process.env.AGENC_COORDINATOR_MODE;
  const envNote =
    envRaw !== undefined && envRaw !== ""
      ? ` (AGENC_COORDINATOR_MODE=${envRaw} overrides the config flag)`
      : "";
  return [
    `Coordinator mode: ${effective ? "ON" : "off"}${envNote}`,
    `Config flag (coordinator_mode): ${configFlag === true ? "true" : configFlag === false ? "false" : "<unset>"}`,
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
      const configFlag = ctx.configStore?.current().coordinator_mode;
      if (arg === "") {
        return { kind: "text", text: statusText(configFlag) };
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
          "Restart the session (or start a new one) to apply — the coordinator prompt and tool allowlist bind at session construction.",
        ].join("\n"),
      };
    }),
};
