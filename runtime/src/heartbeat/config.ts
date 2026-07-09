/**
 * Heartbeat policy resolution (TODO task 14), env > config > default. Disabled
 * by default: no ticks until an operator opts in.
 *
 * Env overrides:
 *   AGENC_HEARTBEAT             "on"/"1"/"true" enables, else disables
 *   AGENC_HEARTBEAT_INTERVAL    seconds between ticks
 *   AGENC_HEARTBEAT_MODEL       utility model for heartbeat turns
 *   AGENC_HEARTBEAT_ACTIVE_HOURS  "startHour-endHour" (24h), e.g. "8-22"
 *   AGENC_HEARTBEAT_TARGET      "none" | "<channelId>:<conversationId>"
 *   AGENC_HEARTBEAT_AGENT       agent id for the budget envelope + session
 */

import type { HeartbeatConfig } from "../config/schema.js";
import type { HeartbeatPolicy, HeartbeatTarget } from "./types.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1800; // 30 min
export const DEFAULT_HEARTBEAT_AGENT = "default";

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** "8-22" → [8, 22]; invalid → null. Hours are [0,24], start < end. */
export function parseActiveHours(
  value: string | undefined,
): readonly [number, number] | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "always" || trimmed === "all") return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(trimmed);
  if (m === null) return null;
  const start = Number.parseInt(m[1], 10);
  const end = Number.parseInt(m[2], 10);
  if (start < 0 || end > 24 || start >= end) return null;
  return [start, end];
}

/** "none" or "<channelId>:<conversationId>" → target; default none. */
export function parseTarget(value: string | undefined): HeartbeatTarget {
  const v = nonEmpty(value);
  if (v === undefined || v.toLowerCase() === "none") return { kind: "none" };
  const idx = v.indexOf(":");
  if (idx <= 0 || idx === v.length - 1) return { kind: "none" };
  return {
    kind: "channel",
    channelId: v.slice(0, idx),
    conversationId: v.slice(idx + 1),
  };
}

export function resolveHeartbeatPolicy(
  config?: HeartbeatConfig,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatPolicy {
  const enabled =
    parseBool(nonEmpty(env.AGENC_HEARTBEAT)) ?? config?.enabled ?? false;

  const intervalSeconds =
    parsePositiveInt(nonEmpty(env.AGENC_HEARTBEAT_INTERVAL)) ??
    (config?.interval_seconds !== undefined && config.interval_seconds > 0
      ? config.interval_seconds
      : DEFAULT_HEARTBEAT_INTERVAL_SECONDS);

  const model = nonEmpty(env.AGENC_HEARTBEAT_MODEL) ?? nonEmpty(config?.model);

  const activeHoursEnv = parseActiveHours(nonEmpty(env.AGENC_HEARTBEAT_ACTIVE_HOURS));
  const activeHours =
    activeHoursEnv !== undefined
      ? activeHoursEnv
      : config?.active_hours !== undefined
        ? parseActiveHoursFromConfig(config.active_hours)
        : null;

  const target =
    nonEmpty(env.AGENC_HEARTBEAT_TARGET) !== undefined
      ? parseTarget(env.AGENC_HEARTBEAT_TARGET)
      : configTarget(config);

  const agentId =
    nonEmpty(env.AGENC_HEARTBEAT_AGENT) ??
    nonEmpty(config?.agent) ??
    DEFAULT_HEARTBEAT_AGENT;

  const skipWhenBusy = config?.skip_when_busy ?? true;

  return {
    enabled,
    intervalSeconds,
    agentId,
    ...(model !== undefined ? { model } : {}),
    activeHours,
    skipWhenBusy,
    target,
  };
}

function parseActiveHoursFromConfig(
  value: readonly number[],
): readonly [number, number] | null {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    value[0] >= 0 &&
    value[1] <= 24 &&
    value[0] < value[1]
  ) {
    return [value[0], value[1]];
  }
  return null;
}

function configTarget(config?: HeartbeatConfig): HeartbeatTarget {
  if (config?.target_channel !== undefined && config.target_conversation !== undefined) {
    return {
      kind: "channel",
      channelId: config.target_channel,
      conversationId: config.target_conversation,
    };
  }
  return { kind: "none" };
}
