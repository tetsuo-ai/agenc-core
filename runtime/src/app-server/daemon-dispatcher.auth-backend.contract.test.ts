import { describe, expect, it } from "vitest";
import type { AuthBackend } from "../auth/backend.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";

function makeAuthBackend(calls: string[]): AuthBackend {
  return {
    login: () => {
      calls.push("login");
      return { authenticated: true, provider: "local" };
    },
    whoami: () => {
      calls.push("whoami");
      return { authenticated: true, provider: "local" };
    },
    logout: () => {
      calls.push("logout");
      return { authenticated: false };
    },
    vendKey: () => {
      calls.push("vendKey");
      throw new Error("not expected");
    },
    inferAgencModel: () => {
      calls.push("inferAgencModel");
      throw new Error("not expected");
    },
    getSubscriptionTier: () => {
      calls.push("getSubscriptionTier");
      return "free";
    },
  };
}

describe("AgenC daemon AuthBackend integration", () => {
  it("routes daemon auth methods through the configured AuthBackend", async () => {
    const calls: string[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      authBackend: makeAuthBackend(calls),
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "init",
        method: "initialize",
        params: {},
      }),
    ).resolves.toMatchObject({ result: { type: "initialized" } });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "login",
        method: "auth.login",
      }),
    ).resolves.toMatchObject({
      result: { authenticated: true, provider: "local" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "whoami",
        method: "auth.whoami",
      }),
    ).resolves.toMatchObject({
      result: { authenticated: true, provider: "local" },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "logout",
        method: "auth.logout",
      }),
    ).resolves.toMatchObject({
      result: { authenticated: false },
    });

    expect(calls).toEqual(["login", "whoami", "logout"]);
  });

  it("fails auth methods explicitly when no AuthBackend is configured", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: {},
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "login",
        method: "auth.login",
      }),
    ).resolves.toMatchObject({
      error: { data: { code: "AUTH_BACKEND_NOT_CONFIGURED" } },
    });
  });
});
