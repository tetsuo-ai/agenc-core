/**
 * AgenC-owned daemon auth method adapter.
 *
 * This keeps F-03d scoped to daemon protocol routing: the canonical
 * AuthBackend interface and concrete local backend live in the A-00 items.
 */

import type {
  AuthLoginResult,
  AuthLogoutResult,
  AuthWhoamiResult,
} from "./protocol/index.js";
import type {
  AuthBackend,
  AuthDaemonSocketIdentity,
} from "../auth/backend.js";

export const AGENC_DAEMON_AUTH_METHODS = [
  "auth.login",
  "auth.whoami",
  "auth.logout",
] as const;

export type AgenCDaemonAuthMethod =
  (typeof AGENC_DAEMON_AUTH_METHODS)[number];

export type AgenCDaemonAuthBackend = Pick<
  AuthBackend,
  "login" | "whoami" | "logout"
>;

export type AgenCDaemonAuthHandlers = {
  readonly [Method in AgenCDaemonAuthMethod]: (
    context?: AgenCDaemonAuthContext,
  ) => Promise<
    Method extends "auth.login"
      ? AuthLoginResult
      : Method extends "auth.logout"
        ? AuthLogoutResult
        : AuthWhoamiResult
  >;
};

export interface AgenCDaemonAuthContext {
  readonly daemonConnection?: AuthDaemonSocketIdentity;
}

export function createAgenCDaemonAuthHandlers(
  backend: AgenCDaemonAuthBackend,
): AgenCDaemonAuthHandlers {
  return {
    "auth.login": async () => sanitizeAuthLoginResult(
      await Promise.resolve(backend.login()),
    ),
    "auth.whoami": async (context = {}) => {
      const result = await Promise.resolve(
        context.daemonConnection === undefined
          ? backend.whoami()
          : backend.whoami({
              daemonConnection: context.daemonConnection,
            }),
      );
      return attachDaemonSocketIdentity(result, context.daemonConnection);
    },
    "auth.logout": () => Promise.resolve(backend.logout()),
  };
}

function sanitizeAuthLoginResult(result: AuthLoginResult): AuthLoginResult {
  // Concrete backends return their persisted bearer to in-process CLI callers.
  // Daemon clients only need the public login state, so cross this trust
  // boundary with an explicit allowlist (including the nested identity).
  const identity = result.identity === undefined
    ? undefined
    : {
        ...(typeof result.identity.accountId === "string"
          ? { accountId: result.identity.accountId }
          : {}),
        ...(typeof result.identity.email === "string"
          ? { email: result.identity.email }
          : {}),
        ...(typeof result.identity.handle === "string"
          ? { handle: result.identity.handle }
          : {}),
        ...(typeof result.identity.displayName === "string"
          ? { displayName: result.identity.displayName }
          : {}),
        ...(typeof result.identity.plan === "string"
          ? { plan: result.identity.plan }
          : {}),
      };
  return {
    authenticated: true,
    ...(result.provider !== undefined ? { provider: result.provider } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

export function isAgenCDaemonAuthMethod(
  method: string,
): method is AgenCDaemonAuthMethod {
  return (AGENC_DAEMON_AUTH_METHODS as readonly string[]).includes(method);
}

function attachDaemonSocketIdentity(
  result: AuthWhoamiResult,
  daemonConnection: AuthDaemonSocketIdentity | undefined,
): AuthWhoamiResult {
  if (daemonConnection === undefined) return result;
  return {
    ...result,
    identity: {
      ...(result.identity ?? {}),
      daemon: daemonConnection,
    },
  };
}
