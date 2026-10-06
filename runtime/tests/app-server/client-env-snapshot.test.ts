import { describe, expect, it } from "vitest";

import {
  captureRecoverableCommandEnvironment,
  captureRecoverableSessionEnvironment,
  collectDaemonClientEnvOverrides,
  DAEMON_CLIENT_ENV_SNAPSHOT_KEYS,
  mergeDaemonClientEnvironment,
  normalizeDaemonClientEnvOverrides,
  readRecoverableCommandEnvironment,
  readRecoverableSessionEnvironment,
  withheldModelProviderCredentials,
} from "../../src/app-server/client-env-snapshot.js";
import { isSecretEnvKey } from "../../src/utils/secretEnv.js";

describe("daemon client environment snapshots", () => {
  it("keeps the local micro receipt path outside the session snapshot", () => {
    const snapshot = collectDaemonClientEnvOverrides({
      AGENC_MICRO_PRINT_RECEIPT: "/tmp/caller-owned-receipt.jsonl",
    });
    expect(snapshot).not.toHaveProperty("AGENC_MICRO_PRINT_RECEIPT");
    expect(() => normalizeDaemonClientEnvOverrides({
      AGENC_MICRO_PRINT_RECEIPT: "/tmp/remote-receipt.jsonl",
    })).toThrow(/unsupported key/);
  });

  it.each([{}, { PATH: "" }])("retains expanded daemon PATH while clearing credentials: %j", overrides => {
    const daemon = { PATH: "/bundled/bin:/home/user/.local/bin:/usr/bin:/bin", DEEPSEEK_API_KEY: "old-key", OPENAI_API_KEY: "old-other" };
    const normalized = normalizeDaemonClientEnvOverrides({ ...overrides, DEEPSEEK_API_KEY: "fresh-key", OPENAI_API_KEY: "" });
    const merged = mergeDaemonClientEnvironment(daemon, normalized);
    expect(merged?.PATH).toBe(daemon.PATH);
    expect(merged?.DEEPSEEK_API_KEY).toBe("fresh-key");
    expect(merged).not.toHaveProperty("OPENAI_API_KEY");
  });

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
    });
    const second = collectDaemonClientEnvOverrides({
      AGENC_REMOTE_SESSION_ID: "session-client-b",
      SESSION_INGRESS_URL: "https://ingress-b.example",
    });

    expect(first).toMatchObject({
      AGENC_REMOTE_SESSION_ID: "session-client-a",
      SESSION_INGRESS_URL: "https://ingress-a.example",
    });
    expect(second).toMatchObject({
      AGENC_REMOTE_SESSION_ID: "session-client-b",
      SESSION_INGRESS_URL: "https://ingress-b.example",
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

  it("accepts only well-formed AGENC_CREDENTIAL_ keys on the protocol surface", () => {
    expect(() =>
      normalizeDaemonClientEnvOverrides({ AGENC_CREDENTIAL_DOCS_MCP: "Bearer x" }),
    ).not.toThrow();
    expect(
      normalizeDaemonClientEnvOverrides({ AGENC_CREDENTIAL_DOCS_MCP: "Bearer x" })
        .AGENC_CREDENTIAL_DOCS_MCP,
    ).toBe("Bearer x");
    for (const key of [
      "AGENC_CREDENTIAL_",
      "AGENC_CREDENTIAL",
      "AGENC_CREDENTIAL_docs",
      "AGENC_CREDENTIAL_FOO-BAR",
    ]) {
      expect(() => normalizeDaemonClientEnvOverrides({ [key]: "secret" })).toThrow(
        new RegExp(`unsupported key.*${key}`, "i"),
      );
    }
  });

  it("captures only PATH for recoverable command environment", () => {
    expect(
      captureRecoverableCommandEnvironment({
        PATH: "/client/bin",
        AGENC_PROVIDER: "gemini",
      }),
    ).toEqual({ PATH: "/client/bin" });
    expect(captureRecoverableCommandEnvironment({ PATH: "   " })).toEqual({
      PATH: "",
    });
    expect(captureRecoverableCommandEnvironment(undefined)).toEqual({ PATH: "" });
  });

  it("rejects malformed recoverable command environment payloads", () => {
    expect(readRecoverableCommandEnvironment({ PATH: "/bin" })).toEqual({
      PATH: "/bin",
    });
    expect(
      readRecoverableCommandEnvironment({ PATH: "/bin", EXTRA: "x" }),
    ).toBeUndefined();
    expect(readRecoverableCommandEnvironment({ PATH: "/bin\0evil" })).toBeUndefined();
    expect(readRecoverableCommandEnvironment(["PATH"])).toBeUndefined();
    expect(readRecoverableCommandEnvironment(null)).toBeUndefined();
    expect(readRecoverableCommandEnvironment({ path: "/bin" })).toBeUndefined();
  });

  it("records non-secret session values and only the names of credentials", () => {
    const recorded = captureRecoverableSessionEnvironment({
      PATH: "/client/bin",
      AGENC_PROVIDER: "openai-compatible",
      AGENC_MODEL: "local-model",
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
      GROK_AUTH_MODE: "api-key",
      QWEN_TOKEN_PLAN_BASE_URL: "https://plan.example/v1",
      AGENC_EFFORT_LEVEL: "   ",
      OPENAI_COMPATIBLE_API_KEY: "local-key-secret",
      AGENC_PROFILE: "local-key-secret",
      GITHUB_TOKEN: "gh-secret",
      AGENC_CREDENTIAL_DOCS_MCP: "Bearer mcp-secret",
      WEB_HEADERS: "Authorization: Bearer web-secret",
      HTTPS_PROXY: "http://user:proxy-secret@proxy.example:8080",
      SESSION_INGRESS_URL: "https://ingress.example/?token=ingress-secret",
      OPENAI_BASE_URL: "sk-pasted-secret",
      RANDOM_SECRET: "not-forwarded-secret",
    });

    expect(recorded).toEqual({
      values: {
        AGENC_MODEL: "local-model",
        AGENC_PROVIDER: "openai-compatible",
        GROK_AUTH_MODE: "api-key",
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4010/v1",
        QWEN_TOKEN_PLAN_BASE_URL: "https://plan.example/v1",
      },
      withheldKeys: [
        "AGENC_CREDENTIAL_DOCS_MCP",
        "AGENC_PROFILE",
        "GITHUB_TOKEN",
        "HTTPS_PROXY",
        "OPENAI_BASE_URL",
        "OPENAI_COMPATIBLE_API_KEY",
        "SESSION_INGRESS_URL",
        "WEB_HEADERS",
      ],
    });
    expect(JSON.stringify(recorded)).not.toMatch(/secret/u);
    expect(
      readRecoverableSessionEnvironment(JSON.parse(JSON.stringify(recorded))),
    ).toEqual(recorded);
    expect(captureRecoverableSessionEnvironment(undefined)).toEqual({
      values: {},
      withheldKeys: [],
    });
  });

  it("withholds every value the shared secret inventory flags, except reviewed configuration keys", () => {
    const recorded = captureRecoverableSessionEnvironment(
      Object.fromEntries(
        DAEMON_CLIENT_ENV_SNAPSHOT_KEYS.map((key) => [key, `${key.toLowerCase()}-value`]),
      ),
    );

    expect(Object.keys(recorded.values).filter((key) => isSecretEnvKey(key)).sort()).toEqual([
      "AGENC_AUTH_BACKEND",
      "AGENC_AUTH_MANAGED_KEYS_ENABLED",
      "AGENC_ENABLE_TOKEN_USAGE_ATTACHMENT",
      "AGENC_TOKEN_BUDGET_CHECK_INTERVAL",
      "DASHSCOPE_TOKEN_PLAN_BASE_URL",
      "GEMINI_AUTH_MODE",
      "GROK_AUTH_MODE",
      "OPENAI_AUTH_HEADER",
      "OPENAI_AUTH_MODE",
      "OPENAI_AUTH_SCHEME",
      "QWEN_TOKEN_PLAN_BASE_URL",
      "WEB_AUTH_HEADER",
      "WEB_AUTH_SCHEME",
    ]);
    for (const key of ["WEB_BODY_TEMPLATE", "WEB_HEADERS", "WEB_PARAMS", "WEB_URL_TEMPLATE"]) {
      expect(recorded.withheldKeys).toContain(key);
    }
    expect(Object.keys(recorded.values).length + recorded.withheldKeys.length).toBe(
      DAEMON_CLIENT_ENV_SNAPSHOT_KEYS.length - 1,
    );
  });

  it.each([
    ["a missing field", { values: {} }],
    ["an extra field", { values: {}, withheldKeys: [], PATH: "/bin" }],
    ["PATH", { values: { PATH: "/bin" }, withheldKeys: [] }],
    ["an unknown key", { values: { RANDOM_SETTING: "x" }, withheldKeys: [] }],
    ["a credential value", { values: { XAI_API_KEY: "secret" }, withheldKeys: [] }],
    ["a dynamic credential value", { values: { AGENC_CREDENTIAL_DOCS_MCP: "Bearer x" }, withheldKeys: [] }],
    ["a URL with user info", { values: { HTTPS_PROXY: "http://u:p@proxy:8080" }, withheldKeys: [] }],
    ["a key-like value", { values: { AGENC_MODEL: "sk-live" }, withheldKeys: [] }],
    ["a NUL byte", { values: { AGENC_MODEL: "model\0" }, withheldKeys: [] }],
    ["an empty value", { values: { AGENC_MODEL: " " }, withheldKeys: [] }],
    ["an unknown withheld name", { values: {}, withheldKeys: ["RANDOM_SECRET"] }],
    ["a duplicate withheld name", { values: {}, withheldKeys: ["XAI_API_KEY", "XAI_API_KEY"] }],
    ["a name both recorded and withheld", { values: { AGENC_MODEL: "m" }, withheldKeys: ["AGENC_MODEL"] }],
    ["a non-object", ["values", "withheldKeys"]],
  ])("rejects a recorded session environment with %s", (_label, value) => {
    expect(readRecoverableSessionEnvironment(value)).toBeUndefined();
  });

  it("counts only the withheld credentials a restored model provider needs", () => {
    const environment = {
      values: {},
      withheldKeys: [
        "AGENC_CREDENTIAL_DOCS_MCP",
        "GITHUB_TOKEN",
        "HTTPS_PROXY",
        "OPENAI_API_KEY",
        "TAVILY_API_KEY",
        "XAI_API_KEY",
      ],
    };

    expect(withheldModelProviderCredentials(environment, "grok")).toEqual([
      "HTTPS_PROXY",
      "XAI_API_KEY",
    ]);
    expect(withheldModelProviderCredentials(environment, "openai-compatible")).toEqual([
      "HTTPS_PROXY",
      "OPENAI_API_KEY",
    ]);
    expect(withheldModelProviderCredentials(environment, "github")).toEqual([
      "GITHUB_TOKEN",
      "HTTPS_PROXY",
    ]);
    expect(withheldModelProviderCredentials(environment, "ollama")).toEqual(["HTTPS_PROXY"]);
    expect(
      withheldModelProviderCredentials({ values: {}, withheldKeys: ["GITHUB_TOKEN"] }, "ollama"),
    ).toEqual([]);
    expect(withheldModelProviderCredentials(environment, "custom-gateway")).toEqual(
      environment.withheldKeys,
    );
    expect(withheldModelProviderCredentials(environment, undefined)).toEqual(
      environment.withheldKeys,
    );
  });
});
