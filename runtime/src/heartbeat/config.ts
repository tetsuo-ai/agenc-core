/**
 * Heartbeat policy projection from the already-layered canonical config.
 * Disabled by default: no ticks until an operator opts in.
 */

import type { HeartbeatConfig } from "../config/schema.js";
import type { HeartbeatPolicy, HeartbeatTarget } from "./types.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1800; // 30 min

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
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
export function parseHeartbeatTarget(
  value: string | undefined,
  label = "heartbeat target",
): HeartbeatTarget {
  const v = nonEmpty(value);
  if (value === undefined || v?.toLowerCase() === "none") return { kind: "none" };
  if (v === undefined) {
    throw new Error(
      `invalid ${label}; expected "none" or ` +
        '"<nonempty-channel>:<nonempty-conversation>"',
    );
  }
  const idx = v.indexOf(":");
  const channelId = v.slice(0, idx).trim();
  const conversationId = v.slice(idx + 1).trim();
  if (idx <= 0 || channelId.length === 0 || conversationId.length === 0) {
    throw new Error(
      `invalid ${label}; expected "none" or ` +
        '"<nonempty-channel>:<nonempty-conversation>"',
    );
  }
  return {
    kind: "channel",
    channelId,
    conversationId,
  };
}

export function resolveHeartbeatPolicy(config?: HeartbeatConfig): HeartbeatPolicy {
  const intervalSeconds =
    (config?.interval_seconds !== undefined &&
    Number.isSafeInteger(config.interval_seconds) &&
    config.interval_seconds > 0
      ? config.interval_seconds
      : DEFAULT_HEARTBEAT_INTERVAL_SECONDS);
  const activeHours =
    config?.active_hours !== undefined
      ? parseActiveHoursFromConfig(config.active_hours)
      : null;
  const target = configTarget(config);

  const skipWhenBusy = config?.skip_when_busy ?? true;

  return {
    enabled: config?.enabled === true,
    intervalSeconds,
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
  const channelId = nonEmpty(config?.target_channel);
  const conversationId = nonEmpty(config?.target_conversation);
  if (channelId !== undefined && conversationId !== undefined) {
    return {
      kind: "channel",
      channelId,
      conversationId,
    };
  }
  return { kind: "none" };
}
