/**
 * /swarm — toggle swarm mode.
 *
 * Swarm mode enables conservative per-turn routing. The runtime creates a
 * model-facing audit receipt and keeps work local unless it finds positive
 * evidence of independent work; qualifying parallel routes require an initial
 * `spawn_agent` attempt and cap fan-out at four workers.
 *
 * /swarm          → show status
 * /swarm on|off   → set explicitly
 * /swarm status   → show mode + active/idle agent counts from AppState.tasks
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

function agentCounts(ctx: SlashCommandContext): {
  readonly active: number;
  readonly idle: number;
} {
  const state = ctx.appState?.getAppState?.() as
    | { tasks?: Record<string, { status?: string; type?: string }> }
    | undefined;
  const tasks = Object.values(state?.tasks ?? {});
  const agents = tasks.filter((task) => task.type === "local_agent");
  return {
    active: agents.filter(
      (task) => task.status === "running" || task.status === "pending",
    ).length,
    idle: agents.filter((task) => task.status === "idle").length,
  };
}

async function setSwarmMode(ctx: SlashCommandContext, on: boolean): Promise<void> {
  await updateSettingsForSource("userSettings", { swarmMode: on });
  ctx.appState?.setAppState?.((prev: unknown) => ({
    ...(prev as Record<string, unknown>),
    swarmMode: on,
  }));
}

export const swarmCommand: SlashCommand = {
  name: "swarm",
  description: "Enable adaptive multi-agent routing — /swarm on|off",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      const arg = ctx.argsRaw.trim().toLowerCase();
      const agents = agentCounts(ctx);

      if (arg === "status" || arg === "") {
        const on = readSwarmMode(ctx);
        const persisted = getSettingsForSource("userSettings")?.swarmMode;
        const lines = [
          `swarm mode: ${on ? "ON" : "off"}${persisted !== undefined ? ` (${persisted ? "saved on" : "saved off"})` : ""}`,
          `agents: ${agents.active} active, ${agents.idle} idle/reusable`,
          on
            ? "Adaptive routing is active: sequential by default; qualifying parallel work requires an initial worker-spawn attempt."
            : "Use /swarm on for conservative adaptive multi-agent routing.",
        ];
        return { kind: "text", text: lines.join("\n") };
      }

      if (arg === "on") {
        await setSwarmMode(ctx, true);
        return {
          kind: "text",
          text: "swarm mode ON — adaptive routing stays sequential by default; qualifying parallel work requires an initial worker-spawn attempt and caps fan-out at four (spawns still follow approval policy).",
        };
      }
      if (arg === "off") {
        await setSwarmMode(ctx, false);
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
