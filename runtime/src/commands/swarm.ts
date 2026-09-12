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
  getExecutionAuthoritySettings,
} from "../utils/settings/settings.js";
import {
  applyCanonicalConfigPatchSync,
  readCanonicalUserConfigSnapshotSync,
} from "../config/update-sync.js";
import { asRecord } from "../utils/record.js";
import { configStoreFromCommandContext, requireCommandConfigStore } from "./config-context.js";

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
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

function requireDaemonConfigApplied(receipt: unknown): void {
  const result = asRecord(receipt);
  // The deferred bridge reloads global config without starting an agent.
  // Its explicit pending-session receipt stages the first conversation.
  if (result?.applied === true || result?.sessionId === "pending") return;
  throw new Error(typeof result?.summary === "string"
    ? result.summary
    : "Daemon did not apply the configuration");
}

async function persistDaemonSwarmMode(
  ctx: SlashCommandContext,
  on: boolean,
  reloadDaemon: () => unknown,
): Promise<void> {
  const store = requireCommandConfigStore(ctx);
  // The client and daemon own separate stores. Persist through the canonical
  // writer, then acknowledge the daemon reload before publishing client
  // settings: its subscribers otherwise change the badge before admission.
  applyCanonicalConfigPatchSync(store.homeContext.configTomlPath, { swarmMode: on }, "user");
  try {
    requireDaemonConfigApplied(await reloadDaemon());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A lost reply can follow a committed daemon reload. A blind disk
    // rollback would introduce another divergence, so retain the preference
    // and keep the client on its last confirmed settings until retry.
    throw new Error(`Swarm preference saved ${on ? "on" : "off"}, but the live daemon update could not be confirmed: ${detail}. The badge still shows the last confirmed mode; run /config reload to retry.`);
  }
  await store.reload();
}

async function setSwarmMode(ctx: SlashCommandContext, on: boolean): Promise<boolean> {
  const applyDaemonConfig = asRecord(ctx.session)?.applyDaemonConfig;
  if (typeof applyDaemonConfig === "function") {
    await persistDaemonSwarmMode(ctx, on, () => applyDaemonConfig.call(ctx.session, { reload: true }));
  } else {
    const { error } = await updateSettingsForSource("userSettings", { swarmMode: on });
    if (error !== null) throw error;
  }
  const effective = getExecutionAuthoritySettings().swarmMode === true;
  ctx.appState?.setAppState?.((prev: unknown) => ({
    ...(prev as Record<string, unknown>),
    swarmMode: effective,
  }));
  return effective;
}

function swarmStatus(ctx: SlashCommandContext): SlashCommandResult {
  const on = readSwarmMode(ctx);
  const agents = agentCounts(ctx);
  const store = configStoreFromCommandContext(ctx);
  const persisted = store === null
    ? getSettingsForSource("userSettings")?.swarmMode
    : readCanonicalUserConfigSnapshotSync(store.homeContext.configTomlPath).raw.swarmMode;
  const savedMode = persisted ? "saved on" : "saved off";
  const saved = persisted === undefined ? "" : ` (${savedMode})`;
  return {
    kind: "text",
    text: [
      `swarm mode: ${on ? "ON" : "off"}${saved}`,
      `agents: ${agents.active} active, ${agents.idle} idle/reusable`,
      on
        ? "Adaptive routing is active: sequential by default; qualifying parallel work requires an initial worker-spawn attempt."
        : "Use /swarm on for conservative adaptive multi-agent routing.",
    ].join("\n"),
  };
}

async function changeSwarmMode(ctx: SlashCommandContext, requested: boolean): Promise<SlashCommandResult> {
  const effective = await setSwarmMode(ctx, requested);
  if (effective !== requested) {
    return {
      kind: "text",
      text: `Swarm preference saved ${requested ? "on" : "off"}; effective swarm mode remains ${effective ? "ON" : "off"} because a higher-priority config layer overrides it. Use /config show to inspect the effective settings.`,
    };
  }
  return {
    kind: "text",
    text: effective
      ? "swarm mode ON — adaptive routing stays sequential by default; qualifying parallel work requires an initial worker-spawn attempt and caps fan-out at four (spawns still follow approval policy)."
      : "swarm mode OFF — the agent works sequentially unless a swarm is explicitly requested.",
  };
}

export const swarmCommand: SlashCommand = {
  name: "swarm",
  description: "Enable adaptive multi-agent routing — /swarm on|off",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      const arg = ctx.argsRaw.trim().toLowerCase();
      switch (arg) {
        case "":
        case "status":
          return swarmStatus(ctx);
        case "on":
        case "off":
          return changeSwarmMode(ctx, arg === "on");
        default:
          return { kind: "error", message: "Usage: /swarm [on|off|status]" };
      }
    }),
};
