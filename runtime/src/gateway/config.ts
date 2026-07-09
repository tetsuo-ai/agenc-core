/**
 * Gateway configuration loader (TODO task 6).
 *
 * Gateway config lives in its own `<agencHome>/gateway/config.json` (not the
 * main config.toml) because its surface grows per channel. Missing file →
 * fail-closed defaults (no channels, pairing-gated, default agent). Malformed
 * entries are dropped with a warning, never coerced into something permissive.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_GATEWAY_CONFIG,
  type DmPolicy,
  type GatewayBinding,
  type GatewayChannelPolicy,
  type GatewayConfig,
} from "./types.js";

const DM_POLICIES: readonly DmPolicy[] = [
  "pairing",
  "allowlist",
  "open",
  "disabled",
];

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function normalizeChannelPolicy(
  value: unknown,
  onWarn: (m: string) => void,
): GatewayChannelPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const dmPolicy = record.dmPolicy;
  if (typeof dmPolicy !== "string" || !DM_POLICIES.includes(dmPolicy as DmPolicy)) {
    onWarn(`gateway: invalid dmPolicy '${String(dmPolicy)}' — skipping channel`);
    return null;
  }
  return {
    dmPolicy: dmPolicy as DmPolicy,
    allowlist: stringArray(record.allowlist),
  };
}

function normalizeBinding(
  value: unknown,
  onWarn: (m: string) => void,
): GatewayBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.agent !== "string" || typeof record.channelId !== "string") {
    onWarn("gateway: binding missing agent/channelId — skipping");
    return null;
  }
  return {
    agent: record.agent,
    channelId: record.channelId,
    ...(typeof record.peerId === "string" ? { peerId: record.peerId } : {}),
    ...(typeof record.groupId === "string" ? { groupId: record.groupId } : {}),
  };
}

export function resolveGatewayConfigPath(agencHome: string): string {
  return join(agencHome, "gateway", "config.json");
}

export interface LoadGatewayConfigOptions {
  readonly agencHome: string;
  readonly onWarn?: (message: string) => void;
}

export function loadGatewayConfig(
  options: LoadGatewayConfigOptions,
): GatewayConfig {
  const onWarn = options.onWarn ?? (() => {});
  const path = resolveGatewayConfigPath(options.agencHome);
  if (!existsSync(path)) return DEFAULT_GATEWAY_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    onWarn(`gateway: config.json is unparseable, using defaults: ${String(error)}`);
    return DEFAULT_GATEWAY_CONFIG;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_GATEWAY_CONFIG;
  const record = raw as Record<string, unknown>;

  const channels: Record<string, GatewayChannelPolicy> = {};
  if (typeof record.channels === "object" && record.channels !== null) {
    for (const [id, value] of Object.entries(
      record.channels as Record<string, unknown>,
    )) {
      const policy = normalizeChannelPolicy(value, onWarn);
      if (policy !== null) channels[id] = policy;
    }
  }

  const bindings: GatewayBinding[] = [];
  if (Array.isArray(record.bindings)) {
    for (const value of record.bindings) {
      const binding = normalizeBinding(value, onWarn);
      if (binding !== null) bindings.push(binding);
    }
  }

  return {
    channels,
    bindings,
    defaultAgent:
      typeof record.defaultAgent === "string" && record.defaultAgent.length > 0
        ? record.defaultAgent
        : DEFAULT_GATEWAY_CONFIG.defaultAgent,
  };
}
