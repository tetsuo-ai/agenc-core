import type { GatewayChannelConfig, GatewayChannelStatus } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function inferGatewayChannelMode(
  name: string,
  config: GatewayChannelConfig | undefined,
): GatewayChannelStatus["mode"] | undefined {
  if (name !== "telegram" || !isRecord(config)) {
    return undefined;
  }
  return isRecord(config.webhook) ? "webhook" : "polling";
}

export function buildGatewayChannelStatus(
  name: string,
  params: {
    targetConfig?: GatewayChannelConfig;
    liveConfig?: GatewayChannelConfig;
    active: boolean;
    health: GatewayChannelStatus["health"];
    pendingRestart: boolean;
    gatewayRunning?: boolean;
  },
): GatewayChannelStatus {
  const targetConfig = params.targetConfig;
  const configured = targetConfig !== undefined;
  const enabled = configured && targetConfig.enabled !== false;
  const mode = inferGatewayChannelMode(name, targetConfig);

  let summary: string | undefined;
  if (params.pendingRestart && params.active && !configured) {
    summary =
      "Live daemon still has this connector active; restart required to remove it.";
  } else if (params.pendingRestart) {
    summary = "Config changed on disk; restart the daemon to apply connector changes.";
  } else if (!configured) {
    summary = "Connector is not configured.";
  } else if (!enabled) {
    summary = "Connector is configured but disabled.";
  } else if (params.active && params.health === "healthy") {
    summary = "Connector is active and healthy.";
  } else if (params.active && params.health === "unhealthy") {
    summary = "Connector is active but unhealthy.";
  } else if (params.active) {
    summary = "Connector is active.";
  } else if (
    params.gatewayRunning &&
    !configsEqual(targetConfig, params.liveConfig)
  ) {
    summary = "Connector config differs from the live daemon state.";
  } else {
    summary = "Connector is configured but not active.";
  }

  return {
    name,
    configured,
    enabled,
    active: params.active,
    health: params.health,
    pendingRestart: params.pendingRestart,
    ...(mode ? { mode } : {}),
    ...(summary ? { summary } : {}),
  };
}
