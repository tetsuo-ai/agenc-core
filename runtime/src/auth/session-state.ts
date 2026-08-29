import { readFileSync } from "node:fs";

import type { EnvSnapshot } from "../config/env.js";
import type { HomeContext } from "../config/home.js";
import type { AuthSubscriptionTier } from "./backend.js";
import { readRemoteBearerCredential } from "./native-credentials.js";

const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN" as const;

interface AuthDiskState {
  readonly provider?: unknown;
  readonly createdAt?: unknown;
  readonly expiresAt?: unknown;
  readonly subscriptionTier?: unknown;
}

interface RemoteAuthSessionState extends AuthDiskState {
  readonly token: string;
}

export interface RemoteAuthSessionReadContext {
  /** Canonical native secure storage and metadata identity captured at ingress. */
  readonly home: HomeContext;
  /** Immutable session/CLI environment captured at the same ingress. */
  readonly environment: EnvSnapshot;
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
  context: RemoteAuthSessionReadContext,
): RemoteAuthSessionState | null {
  try {
    const explicitToken = trimNonEmpty(
      context.environment[REMOTE_AUTH_TOKEN_ENV],
    );
    if (explicitToken !== undefined) {
      return { token: explicitToken };
    }
    const state = JSON.parse(
      readFileSync(context.home.authPath, "utf8"),
    ) as AuthDiskState;
    if (state.provider !== "remote") return null;
    const credential = readRemoteBearerCredential(
      context.home,
    );
    if (
      credential === undefined ||
      typeof state.createdAt !== "string" ||
      credential.createdAt !== state.createdAt
    ) {
      return null;
    }
    if (typeof state.expiresAt === "string") {
      const expiresAtMs = Date.parse(state.expiresAt);
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        return null;
      }
    }
    return { ...state, token: credential.bearerToken };
  } catch {
    return null;
  }
}

export function hasRemoteAuthSessionSync(
  context: RemoteAuthSessionReadContext,
): boolean {
  return readRemoteAuthSessionSync(context) !== null;
}

export function remoteAuthSessionTokenSync(
  context: RemoteAuthSessionReadContext,
): string | undefined {
  return readRemoteAuthSessionSync(context)?.token;
}

export function remoteAuthSessionSubscriptionTierSync(
  context: RemoteAuthSessionReadContext,
): AuthSubscriptionTier | undefined {
  return normalizeSubscriptionTier(
    readRemoteAuthSessionSync(context)?.subscriptionTier,
  );
}

export function hasEntitledRemoteAuthSessionSync(
  context: RemoteAuthSessionReadContext,
): boolean {
  return isEntitledSubscriptionTier(
    remoteAuthSessionSubscriptionTierSync(context),
  );
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
