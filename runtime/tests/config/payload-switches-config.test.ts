import { resolveWebSearchMode } from "../../src/tools/web-search-mode.js";
import { snapshotProviderEnvironment } from "../../src/llm/provider-environment.js";
import { describe, expect, test } from "vitest";
import { validateAgenCConfigBlocks, type AgenCConfig } from "../../src/config/schema.js";
import { rareToolDeferralEnabled } from "../../src/tools/rare-tool-deferral.js";
import { leanSystemPromptEnabled } from "../../src/prompts/lean-system-prompt.js";

// config.toml keys for the two payload switches; the session environment
// variables keep overriding them.
describe("payload switch config keys", () => {
  test("accept booleans and reject strings", () => {
    expect(() => validateAgenCConfigBlocks({ defer_rare_tools: false, lean_system_prompt: true })).not.toThrow();
    expect(() => validateAgenCConfigBlocks({ defer_rare_tools: "false" } as unknown as AgenCConfig)).toThrow(/defer_rare_tools/);
    expect(() => validateAgenCConfigBlocks({ lean_system_prompt: "true" } as unknown as AgenCConfig)).toThrow(/lean_system_prompt/);
  });

  test("defer_rare_tools: config sets the session default, the environment wins", () => {
    expect(rareToolDeferralEnabled({}, { configured: false })).toBe(false);
    expect(rareToolDeferralEnabled({}, { lightMode: true, configured: true })).toBe(true);
    expect(rareToolDeferralEnabled({ AGENC_DEFER_RARE_TOOLS: "1" }, { configured: false })).toBe(true);
    expect(rareToolDeferralEnabled({ AGENC_DEFER_RARE_TOOLS: "0" }, { configured: true })).toBe(false);
    expect(rareToolDeferralEnabled({})).toBe(true);
  });

  test("lean_system_prompt: config sets the provider default, the environment wins", () => {
    expect(leanSystemPromptEnabled({}, "deepseek", false)).toBe(false);
    expect(leanSystemPromptEnabled({}, "anthropic", true)).toBe(true);
    expect(leanSystemPromptEnabled({ AGENC_LEAN_SYSTEM_PROMPT: "1" }, "anthropic", false)).toBe(true);
    expect(leanSystemPromptEnabled({ AGENC_LEAN_SYSTEM_PROMPT: "0" }, "deepseek", true)).toBe(false);
    expect(leanSystemPromptEnabled({}, "deepseek")).toBe(false);
    expect(leanSystemPromptEnabled({}, "openai")).toBe(true);
  });
});


test("web search defaults to Auto; session environment overrides config", () => {
  for (const mode of ["auto", "on"] as const) {
    expect(() => validateAgenCConfigBlocks({ web_search: mode })).not.toThrow();
    expect(resolveWebSearchMode({}, mode)).toBe(mode);
    expect(resolveWebSearchMode(snapshotProviderEnvironment({ AGENC_WEB_SEARCH: mode }), mode === "on" ? "auto" : "on")).toBe(mode);
  }
  expect(resolveWebSearchMode({})).toBe("auto");
  expect(resolveWebSearchMode({ AGENC_WEB_SEARCH: "invalid" }, "on")).toBe("on");
  for (const value of [true, false, "off", "invalid"]) {
    expect(() => validateAgenCConfigBlocks({ web_search: value } as unknown as AgenCConfig)).toThrow(/web_search/);
  }
});
