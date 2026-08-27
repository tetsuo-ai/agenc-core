import { describe, expect, it } from "vitest";

import {
  collectDaemonClientEnvOverrides,
  DAEMON_CLIENT_ENV_SNAPSHOT_KEYS,
  mergeDaemonClientEnvironment,
  normalizeDaemonClientEnvOverrides,
} from "../../src/app-server/client-env-snapshot.js";

describe("daemon client environment snapshots", () => {
  it("captures every allowlisted key and uses empty strings as clear markers", () => {
    const snapshot = collectDaemonClientEnvOverrides({
      AGENC_PROVIDER: "gemini",
      AGENC_MODEL: "gemini-2.5-pro",
      PATH: "/client/bin",
    });

    expect(Object.keys(snapshot).sort()).toEqual(
      [...DAEMON_CLIENT_ENV_SNAPSHOT_KEYS].sort(),
    );
    expect(snapshot).toMatchObject({
      AGENC_PROVIDER: "gemini",
      AGENC_MODEL: "gemini-2.5-pro",
      OPENAI_BASE_URL: "",
      XAI_API_KEY: "",
      AGENC_GROK_CLI: "",
      AGENC_GROK_ACP_PERMISSIONS: "",
      AGENC_OPENROUTER_HTTP_REFERER: "",
      AGENC_OPENROUTER_TITLE: "",
      AGENC_BROWSER_HEADLESS: "",
      AGENC_BUDGET_DAILY_USD: "",
      AGENC_HEARTBEAT_INTERVAL: "",
      AGENC_TRANSACTION_GUARD_TIMEOUT_MS: "",
      PATH: "/client/bin",
    });
  });

  it("clears every policy override between daemon clients", () => {
    const daemonEnv = {
      AGENC_BROWSER_HEADLESS: "off",
      AGENC_BUDGET: "on",
      AGENC_HEARTBEAT_INTERVAL: "60",
      AGENC_TRANSACTION_GUARD: "slm",
    };
    const nextClient = collectDaemonClientEnvOverrides({});

    expect({ ...daemonEnv, ...nextClient }).toMatchObject({
      AGENC_BROWSER_HEADLESS: "",
      AGENC_BUDGET: "",
      AGENC_HEARTBEAT_INTERVAL: "",
      AGENC_TRANSACTION_GUARD: "",
    });
  });

  it("materializes protocol clear markers as absent runtime values", () => {
    const merged = mergeDaemonClientEnvironment(
      {
        HOME: "/daemon/home",
        AGENC_PROVIDER: "openai",
        AGENC_EFFORT_LEVEL: "high",
        AGENC_CREDENTIAL_DOCS_MCP: "Bearer stale-client",
      },
      { AGENC_EFFORT_LEVEL: "   " },
    );

    expect(merged).toMatchObject({ HOME: "/daemon/home" });
    expect(merged).not.toHaveProperty("AGENC_PROVIDER");
    expect(merged).not.toHaveProperty("AGENC_EFFORT_LEVEL");
    expect(merged).not.toHaveProperty("AGENC_CREDENTIAL_DOCS_MCP");
  });

  it("materializes one client's values while clearing omitted session state", () => {
    const merged = mergeDaemonClientEnvironment(
      {
        AGENC_PROVIDER: "openai",
        AGENC_EFFORT_LEVEL: "high",
      },
      collectDaemonClientEnvOverrides({
        AGENC_PROVIDER: "gemini",
        PATH: "/client/bin",
      }),
    );

    expect(merged).toMatchObject({
      AGENC_PROVIDER: "gemini",
      PATH: "/client/bin",
    });
    expect(merged).not.toHaveProperty("AGENC_EFFORT_LEVEL");
  });

  it("captures onboarding display control for the owning TUI session", () => {
    const forced = collectDaemonClientEnvOverrides({
      AGENC_ONBOARDING: "force",
    });
    const ordinary = collectDaemonClientEnvOverrides({});

    expect(forced.AGENC_ONBOARDING).toBe("force");
    expect(ordinary.AGENC_ONBOARDING).toBe("");
  });

  it("isolates remote attribution metadata without duplicating remote behavior", () => {
    const first = collectDaemonClientEnvOverrides({
      AGENC_REMOTE: "1",
      AGENC_REMOTE_SESSION_ID: "session-client-a",
      SESSION_INGRESS_URL: "https://ingress-a.example",
      USER_TYPE: "ant",
    });
    const second = collectDaemonClientEnvOverrides({
      AGENC_REMOTE_SESSION_ID: "session-client-b",
      SESSION_INGRESS_URL: "https://ingress-b.example",
    });

    expect(first).toMatchObject({
      AGENC_REMOTE_SESSION_ID: "session-client-a",
      SESSION_INGRESS_URL: "https://ingress-a.example",
      USER_TYPE: "ant",
    });
    expect(second).toMatchObject({
      AGENC_REMOTE_SESSION_ID: "session-client-b",
      SESSION_INGRESS_URL: "https://ingress-b.example",
      USER_TYPE: "",
    });
    expect(first).not.toHaveProperty("AGENC_REMOTE");
    expect(second).not.toHaveProperty("AGENC_REMOTE");
  });

  it("captures only dedicated dynamic credential names and clears inherited ones", () => {
    const firstClient = collectDaemonClientEnvOverrides({
      AGENC_CREDENTIAL_DOCS_MCP: "Bearer client-a",
      UNPREFIXED_MCP_SECRET: "must-not-cross",
    });
    expect(firstClient.AGENC_CREDENTIAL_DOCS_MCP).toBe("Bearer client-a");
    expect(firstClient.UNPREFIXED_MCP_SECRET).toBeUndefined();

    const secondClient = normalizeDaemonClientEnvOverrides(
      {},
      { AGENC_CREDENTIAL_DOCS_MCP: "Bearer daemon-or-client-a" },
    );
    expect(secondClient.AGENC_CREDENTIAL_DOCS_MCP).toBe("");
  });

  it("carries only the canonical model selector between daemon clients", () => {
    const daemonEnv = {
      AGENC_PROVIDER: "openai",
      OPENAI_MODEL: "stale-daemon-model",
      OPENAI_BASE_URL: "https://stale-daemon.example/v1",
      GEMINI_MODEL: "stale-gemini-model",
    };
    const firstClient = collectDaemonClientEnvOverrides({
      AGENC_PROVIDER: "gemini",
      AGENC_MODEL: "gemini-2.5-pro",
    });
    const secondClient = collectDaemonClientEnvOverrides({});

    expect({ ...daemonEnv, ...firstClient }).toMatchObject({
      AGENC_PROVIDER: "gemini",
      AGENC_MODEL: "gemini-2.5-pro",
      OPENAI_BASE_URL: "",
    });
    expect({ ...daemonEnv, ...secondClient }).toMatchObject({
      AGENC_PROVIDER: "",
      AGENC_MODEL: "",
      OPENAI_BASE_URL: "",
    });
    expect(firstClient).not.toHaveProperty("GEMINI_MODEL");
    expect(firstClient).not.toHaveProperty("OPENAI_MODEL");
  });

  it("does not forward workspace, home, or arbitrary client variables", () => {
    const snapshot = collectDaemonClientEnvOverrides({
      AGENC_WORKSPACE: "/wrong-workspace",
      AGENC_HOME: "/wrong-home",
      RANDOM_SECRET: "do-not-forward",
    });

    expect(snapshot.AGENC_WORKSPACE).toBeUndefined();
    expect(snapshot.AGENC_HOME).toBeUndefined();
    expect(snapshot.RANDOM_SECRET).toBeUndefined();
  });

  it("normalizes an omitted raw protocol snapshot into fail-closed clears", () => {
    const daemonEnv = {
      AGENC_PROVIDER: "openai",
      AGENC_MODEL: "daemon-model",
      OPENAI_API_KEY: "daemon-secret",
      FIRECRAWL_API_KEY: "daemon-search-secret",
      WEB_SEARCH_PROVIDER: "firecrawl",
    };
    const normalized = normalizeDaemonClientEnvOverrides(undefined);

    expect(Object.keys(normalized).sort()).toEqual(
      [...DAEMON_CLIENT_ENV_SNAPSHOT_KEYS].sort(),
    );
    expect({ ...daemonEnv, ...normalized }).toMatchObject({
      AGENC_PROVIDER: "",
      AGENC_MODEL: "",
      OPENAI_API_KEY: "",
      FIRECRAWL_API_KEY: "",
      WEB_SEARCH_PROVIDER: "",
    });
  });

  it("rejects unknown, home, workspace, and retired raw protocol keys", () => {
    for (const [key, value] of [
      ["RANDOM_SECRET", "secret"],
      ["AGENC_HOME", "/redirected"],
      ["AGENC_WORKSPACE", "/redirected"],
    ] as const) {
      expect(() => normalizeDaemonClientEnvOverrides({ [key]: value })).toThrow(
        new RegExp(`unsupported key.*${key}`, "i"),
      );
    }
    expect(() =>
      normalizeDaemonClientEnvOverrides({ OPENAI_MODEL: "retired" }),
    ).toThrow(/obsolete configuration environment variable.*OPENAI_MODEL/i);
    expect(() =>
      normalizeDaemonClientEnvOverrides({ DOCS_MCP_AUTHORIZATION: "secret" }),
    ).toThrow(/unsupported key.*DOCS_MCP_AUTHORIZATION/i);
  });
});
