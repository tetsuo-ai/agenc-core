import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgenCDaemonAgentManager } from "../app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../app-server/daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "../app-server/protocol/index.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import {
  createAgenCPortalDaemonInitializeRequest,
  AGENC_PORTAL_AUTH_METHODS,
  AGENC_PORTAL_METHODS,
} from "./index.js";

describe("AgenC portal AuthBackend contract", () => {
  it("routes portal auth actions through the daemon AuthBackend token store", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-portal-auth-"));
    const backend = new LocalAuthBackend({
      agencHome,
      randomUUID: () => "portal-auth-token",
      now: () => new Date("2026-05-06T00:00:00.000Z"),
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      authBackend: backend,
      initializeAuthenticator: (params) =>
        params.authCookie === "daemon-cookie"
          ? {
              transport: "daemon",
              verifiedBy: "cookie",
              cookie: "verified",
              peerUid: null,
            }
          : false,
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        ...createAgenCPortalDaemonInitializeRequest("daemon-cookie"),
        id: "initialize",
      }),
    ).resolves.toMatchObject({ result: { type: "initialized" } });

    const loginResponse = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "login",
      method: "auth.login",
    });
    expect(loginResponse).toMatchObject({
      result: {
        authenticated: true,
        provider: "local",
      },
    });
    expect(JSON.stringify(loginResponse)).not.toContain("portal-auth-token");
    await expect(
      readAuthToken(join(agencHome, "auth.json")),
    ).resolves.toBe("portal-auth-token");

    const whoamiResponse = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "whoami",
      method: "auth.whoami",
    });
    expect(whoamiResponse).toMatchObject({
      result: {
        authenticated: true,
        provider: "local",
        identity: {
          accountId: "local",
          daemon: {
            transport: "daemon",
            verifiedBy: "cookie",
            cookie: "verified",
            peerUid: null,
          },
        },
      },
    });
    expect(JSON.stringify(whoamiResponse)).not.toContain("portal-auth-token");

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "logout",
        method: "auth.logout",
      }),
    ).resolves.toMatchObject({
      result: { authenticated: false },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "whoami-after-logout",
        method: "auth.whoami",
      }),
    ).resolves.toMatchObject({
      result: { authenticated: false },
    });
  });

  it("keeps auth mutations inside the portal allowlist", () => {
    expect(AGENC_PORTAL_METHODS).toEqual(
      expect.arrayContaining(AGENC_PORTAL_AUTH_METHODS),
    );
    expect(AGENC_PORTAL_METHODS).not.toContain("tool.approve");
    expect(AGENC_PORTAL_METHODS).not.toContain("permission.list");
  });
});

async function readAuthToken(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
  if (typeof parsed.token !== "string") {
    throw new Error("auth token was not persisted");
  }
  return parsed.token;
}
