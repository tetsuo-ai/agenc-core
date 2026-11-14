import { describe, expect, test } from "vitest";
import { validateToolsConfig } from "../../src/config/strict-schema.js";
import { configuredSearchChain } from "../../src/tools/WebSearchTool/providers/live.js";
import { standaloneToolsConfig } from "../../src/tools/system/deepseek-standalone.js";

describe("standalone DeepSeek config", () => {
  test("is absent by default and never joins automatic keyed search", () => {
    expect(validateToolsConfig(undefined)).toBeUndefined();
    expect(configuredSearchChain({ DEEPSEEK_API_KEY: "test" }).providers.map(p => p.name)).not.toContain("deepseek");
  });
  test("accepts each independent opt-in and explicit local alternatives", () => {
    const config = { web_search_provider: "deepseek", web_fetch_provider: "deepseek", file_read_provider: "deepseek" };
    expect(validateToolsConfig(config)).toEqual(config);
    expect(configuredSearchChain({}, config)).toEqual({ mode: "deepseek", providers: [] });
    expect(validateToolsConfig({ web_fetch_provider: "local", file_read_provider: "local" })).toBeDefined();
    expect(configuredSearchChain({ WEB_SEARCH_PROVIDER: "ddg" }, config).mode).toBe("ddg");
  });
  test.each(["web_search_provider", "web_fetch_provider", "file_read_provider"])("rejects invalid %s values", key => {
    for (const value of [true, 3, "DeepSeek", "enabled", {}]) expect(() => validateToolsConfig({ [key]: value })).toThrow(key);
  });
  test("a child does not inherit a parent registry opt-in", () => {
    expect(standaloneToolsConfig({ registrySession: false, session: { services: {} } }, { file_read_provider: "deepseek" })).toBeUndefined();
    expect(standaloneToolsConfig({ registrySession: true, session: { services: { configStore: { current: () => ({}) } } } }, { file_read_provider: "deepseek" })).toBeUndefined();
  });
});
