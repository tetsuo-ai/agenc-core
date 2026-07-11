import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_METHODS,
  isAgenCDaemonMethod,
} from "./protocol/index.js";
import {
  AGENC_DAEMON_AUTH_METHODS,
  createAgenCDaemonAuthHandlers,
  isAgenCDaemonAuthMethod,
} from "./auth.js";
import type { AuthBackend } from "../auth/backend.js";

describe("AgenC daemon auth surface", () => {
  it("exposes only the AgenC-owned auth method trio", () => {
    expect(AGENC_DAEMON_AUTH_METHODS).toEqual([
      "auth.login",
      "auth.whoami",
      "auth.logout",
    ]);
    expect(AGENC_DAEMON_METHODS).toEqual(
      expect.arrayContaining(AGENC_DAEMON_AUTH_METHODS),
    );

    for (const method of AGENC_DAEMON_AUTH_METHODS) {
      expect(isAgenCDaemonMethod(method)).toBe(true);
      expect(isAgenCDaemonAuthMethod(method)).toBe(true);
    }

    for (const method of [
      "account/login/start",
      "account/logout",
      "account/read",
      "experimentalFeature/list",
      "plugin/list",
    ]) {
      expect(isAgenCDaemonMethod(method)).toBe(false);
      expect(isAgenCDaemonAuthMethod(method)).toBe(false);
    }
  });

  it("routes auth methods through the supplied backend shape", async () => {
    const calls: string[] = [];
    const daemonConnection = {
      transport: "daemon",
      verifiedBy: "cookie",
      cookie: "verified",
      peerUid: null,
    } as const;
    const backend: Pick<AuthBackend, "login" | "whoami" | "logout"> = {
      login: () => {
        calls.push("login");
        return {
          authenticated: true,
          provider: "local",
          token: "daemon-bearer-secret",
          refreshToken: "daemon-refresh-secret",
          identity: {
            accountId: "acct-1",
            displayName: "Daemon User",
            bearer: "nested-bearer-secret",
          },
        };
      },
      whoami: (params = {}) => {
        calls.push(`whoami:${params.daemonConnection?.cookie ?? ""}`);
        return { authenticated: true, provider: "local" };
      },
      logout: () => {
        calls.push("logout");
        return { authenticated: false };
      },
    };
    const handlers = createAgenCDaemonAuthHandlers(backend);

    await expect(handlers["auth.login"]()).resolves.toEqual({
      authenticated: true,
      provider: "local",
      identity: {
        accountId: "acct-1",
        displayName: "Daemon User",
      },
    });
    await expect(
      handlers["auth.whoami"]({ daemonConnection }),
    ).resolves.toEqual({
      authenticated: true,
      provider: "local",
      identity: {
        daemon: daemonConnection,
      },
    });
    await expect(handlers["auth.logout"]()).resolves.toEqual({
      authenticated: false,
    });
    expect(calls).toEqual(["login", "whoami:verified", "logout"]);
  });
});
