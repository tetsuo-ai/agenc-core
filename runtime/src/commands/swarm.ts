/**
 * /swarm — toggle swarm mode.
 *
 * Swarm mode declares intent: while it is on, the agent is nudged (via the
 * swarm-mode prompt attachment) to fan out divisible work to parallel
 * sub-agents by default instead of grinding sequentially. It changes the
 * model's guidance, NOT the permission policy — spawn_agent/multi-agent
 * calls are side-effecting and still require approval per the active
 * permission mode (yolo/bypass auto-approves them like everything else).
 *
 * /swarm          → toggle on/off
 * /swarm on|off   → set explicitly
 * /swarm status   → show mode + live agent count from AppState.tasks
 */

import {
  updateSettingsForSource,
  getSettingsForSource,
} from "../utils/settings/settings.js";

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
} from "./types.js";

function readSwarmMode(ctx: SlashCommandContext): boolean {
  const state = ctx.appState?.getAppState?.() as
    | { swarmMode?: unknown }
    | undefined;
  return state?.swarmMode === true;
}

function liveAgentCount(ctx: SlashCommandContext): number {
  const state = ctx.appState?.getAppState?.() as
    | { tasks?: Record<string, { status?: string; type?: string }> }
    | undefined;
  const tasks = Object.values(state?.tasks ?? {});
  return tasks.filter(
    (task) =>
      task.type !== "local_bash" &&
      (task.status === "running" || task.status === "pending"),
  ).length;
}

function setSwarmMode(ctx: SlashCommandContext, on: boolean): void {
  updateSettingsForSource("userSettings", { swarmMode: on });
  ctx.appState?.setAppState?.((prev: unknown) => ({
    ...(prev as Record<string, unknown>),
    swarmMode: on,
  }));
}

export const swarmCommand: SlashCommand = {
  name: "swarm",
  description: "Fan out work to parallel sub-agents — /swarm on|off",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      const arg = ctx.argsRaw.trim().toLowerCase();
      const running = liveAgentCount(ctx);

      if (arg === "status" || arg === "") {
        const on = readSwarmMode(ctx);
        const persisted = getSettingsForSource("userSettings")?.swarmMode;
        const lines = [
          `swarm mode: ${on ? "ON" : "off"}${persisted !== undefined ? ` (${persisted ? "saved on" : "saved off"})` : ""}`,
          `live agents: ${running}`,
          on
            ? "Divisible work fans out to parallel sub-agents by default (spawns still follow approval policy)."
            : "Use /swarm on to fan out divisible work to parallel sub-agents by default.",
        ];
        return { kind: "text", text: lines.join("\n") };
      }

      if (arg === "on") {
        setSwarmMode(ctx, true);
        return {
          kind: "text",
          text: "swarm mode ON — divisible work fans out to parallel sub-agents by default (spawns still follow approval policy).",
        };
      }
      if (arg === "off") {
        setSwarmMode(ctx, false);
        return {
          kind: "text",
          text: "swarm mode OFF — the agent works sequentially unless a swarm is explicitly requested.",
        };
      }

      return {
        kind: "error",
        message: "Usage: /swarm [on|off|status]",
      };
    }),
};
