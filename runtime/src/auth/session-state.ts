import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAgencHome, type EnvSnapshot } from "../config/env.js";
import type { AuthSubscriptionTier } from "./backend.js";

interface AuthDiskState {
  readonly provider?: unknown;
  readonly token?: unknown;
  readonly expiresAt?: unknown;
  readonly subscriptionTier?: unknown;
}

function normalizeSubscriptionTier(
  value: unknown,
): AuthSubscriptionTier | undefined {
  return value === "free" ||
    value === "pro" ||
    value === "team" ||
    value === "enterprise"
    ? value
    : undefined;
}

function isEntitledSubscriptionTier(
  value: AuthSubscriptionTier | undefined,
): boolean {
  return value === "pro" || value === "team" || value === "enterprise";
}

function readRemoteAuthSessionSync(
  env: EnvSnapshot = process.env,
): AuthDiskState | null {
  try {
    const state = JSON.parse(
      readFileSync(join(resolveAgencHome(env), "auth.json"), "utf8"),
    ) as AuthDiskState;
    if (state.provider !== "remote") return null;
    if (typeof state.token !== "string" || state.token.trim().length === 0) {
      return null;
    }
    if (typeof state.expiresAt === "string") {
      const expiresAtMs = Date.parse(state.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        return null;
      }
    }
    return state;
  } catch {
    return null;
  }
}

export function hasRemoteAuthSessionSync(
  env: EnvSnapshot = process.env,
): boolean {
  return readRemoteAuthSessionSync(env) !== null;
}

export function remoteAuthSessionTokenSync(
  env: EnvSnapshot = process.env,
): string | undefined {
  return readRemoteAuthSessionSync(env)?.token as string | undefined;
}

export function remoteAuthSessionSubscriptionTierSync(
  env: EnvSnapshot = process.env,
): AuthSubscriptionTier | undefined {
  return normalizeSubscriptionTier(
    readRemoteAuthSessionSync(env)?.subscriptionTier,
  );
}

export function hasEntitledRemoteAuthSessionSync(
  env: EnvSnapshot = process.env,
): boolean {
  return isEntitledSubscriptionTier(remoteAuthSessionSubscriptionTierSync(env));
}
