import { describe, expect, test } from "vitest";
import { applyEnvOverrides } from "../../src/config/env.js";
import { validateAgenCConfigBlocks, type AgenCConfig } from "../../src/config/schema.js";
import { snapshotProviderEnvironment } from "../../src/llm/provider-environment.js";
import { LEAN_REQUEST_DEFAULTS, resolveLightRequest } from "../../src/session/light-request/settings.js";
import { collectDaemonClientEnvOverrides, mergeDaemonClientEnvironment, captureRecoverableSessionEnvironment,
  readRecoverableSessionEnvironment } from "../../src/app-server/client-env-snapshot.js";

const session = (config: AgenCConfig = {}, env = {}, lightMode = true) => ({ services: {
  configStore: { current: () => config }, providerEnvironment: env, runtimeOptions: { lightMode },
} });

describe("Light request configuration", () => {
  test("defaults to full and only opts native DeepSeek Light into lean", () => {
    expect(resolveLightRequest(session(), "deepseek")).toBeUndefined();
    expect(resolveLightRequest(session({ light_request: "lean" }), "deepseek")).toEqual(LEAN_REQUEST_DEFAULTS);
    for (const provider of ["agenc", "openrouter", "openai", undefined]) {
      expect(resolveLightRequest(session({ light_request: "lean" }), provider)).toBeUndefined();
    }
    expect(resolveLightRequest(session({ light_request: "lean" }, {}, false), "deepseek")).toBeUndefined();
  });

  test("captures the client override and validates it at config ingress", () => {
    const env = snapshotProviderEnvironment({ AGENC_LIGHT_REQUEST: "lean" });
    expect(env.AGENC_LIGHT_REQUEST).toBe("lean");
    expect(applyEnvOverrides({ light_request: "full" }, env).light_request).toBe("lean");
    expect(resolveLightRequest(session({ light_request: "full" }, env), "deepseek")).toEqual(LEAN_REQUEST_DEFAULTS);
    expect(resolveLightRequest(session({ light_request: "lean" }, { AGENC_LIGHT_REQUEST: "full" }), "deepseek")).toBeUndefined();
    expect(() => applyEnvOverrides({}, { AGENC_LIGHT_REQUEST: "bare" })).toThrow(/full or lean/);
  });

  test("forwards the override through daemon ingress and recovery without leaking another client's choice", () => {
    const client = collectDaemonClientEnvOverrides({ AGENC_LIGHT_REQUEST: "lean" });
    expect(client.AGENC_LIGHT_REQUEST).toBe("lean");
    const env = mergeDaemonClientEnvironment({ AGENC_LIGHT_REQUEST: "full" }, client)!;
    expect(applyEnvOverrides({}, env).light_request).toBe("lean");
    const saved = captureRecoverableSessionEnvironment(client);
    expect(readRecoverableSessionEnvironment(saved)?.values.AGENC_LIGHT_REQUEST).toBe("lean");
    const ordinary = mergeDaemonClientEnvironment(env, collectDaemonClientEnvOverrides({}))!;
    expect(ordinary).not.toHaveProperty("AGENC_LIGHT_REQUEST");
    expect(applyEnvOverrides({}, ordinary)).not.toHaveProperty("light_request");
  });

  test("each part can be changed independently", () => {
    for (const [key, value] of Object.entries(LEAN_REQUEST_DEFAULTS)) {
      if (typeof value !== "boolean") continue;
      const config: AgenCConfig = { light_request: "lean", light_request_options: { [key]: !value } };
      expect(() => validateAgenCConfigBlocks(config)).not.toThrow();
      expect(resolveLightRequest(session(config), "deepseek")).toEqual({ ...LEAN_REQUEST_DEFAULTS, [key]: !value });
    }
  });

  test("edit_mode selects tools, shell or check and rejects anything else", () => {
    expect(LEAN_REQUEST_DEFAULTS.edit_mode).toBe("shell");
    expect(resolveLightRequest(session({ light_request: "lean" }), "deepseek")?.edit_mode).toBe("shell");
    for (const edit_mode of ["tools", "shell", "check"] as const) {
      const config: AgenCConfig = { light_request: "lean", light_request_options: { edit_mode } };
      expect(() => validateAgenCConfigBlocks(config)).not.toThrow();
      expect(resolveLightRequest(session(config), "deepseek")).toEqual({ ...LEAN_REQUEST_DEFAULTS, edit_mode });
    }
    for (const edit_mode of ["Shell", "write", true, 1, ""]) {
      expect(() => validateAgenCConfigBlocks({ light_request: "lean",
        light_request_options: { edit_mode } as never })).toThrow(/edit_mode/u);
    }
    // Outside lean the option has no effect.
    expect(resolveLightRequest(session({ light_request_options: { edit_mode: "shell" } }), "deepseek")).toBeUndefined();
  });

  test("system_text selects the short or the minimal built-in text", () => {
    expect(LEAN_REQUEST_DEFAULTS.system_text).toBe("minimal");
    for (const system_text of ["short", "minimal"] as const) {
      const config: AgenCConfig = { light_request: "lean", light_request_options: { system_text } };
      expect(() => validateAgenCConfigBlocks(config)).not.toThrow();
      expect(resolveLightRequest(session(config), "deepseek")).toEqual({ ...LEAN_REQUEST_DEFAULTS, system_text });
    }
    for (const system_text of ["bare", true, 1, ""]) {
      expect(() => validateAgenCConfigBlocks({ light_request_options: { system_text } } as never)).toThrow(/light_request_options\.system_text/);
    }
  });

  test.each([
    { light_request: true }, { light_request: "bare" }, { light_request_options: [] },
    { light_request_options: { process_tools: "false" } }, { light_request_options: { typo: true } },
  ])("rejects invalid config %j", config => {
    expect(() => validateAgenCConfigBlocks(config as AgenCConfig)).toThrow(/light_request/);
  });
});
