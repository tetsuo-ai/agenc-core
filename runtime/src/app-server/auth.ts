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
import type { AuthBackend } from "../auth/backend.js";

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
  readonly [Method in AgenCDaemonAuthMethod]: () => Promise<
    Method extends "auth.login"
      ? AuthLoginResult
      : Method extends "auth.logout"
        ? AuthLogoutResult
        : AuthWhoamiResult
  >;
};

export function createAgenCDaemonAuthHandlers(
  backend: AgenCDaemonAuthBackend,
): AgenCDaemonAuthHandlers {
  return {
    "auth.login": () => Promise.resolve(backend.login()),
    "auth.whoami": () => Promise.resolve(backend.whoami()),
    "auth.logout": () => Promise.resolve(backend.logout()),
  };
}

export function isAgenCDaemonAuthMethod(
  method: string,
): method is AgenCDaemonAuthMethod {
  return (AGENC_DAEMON_AUTH_METHODS as readonly string[]).includes(method);
}
