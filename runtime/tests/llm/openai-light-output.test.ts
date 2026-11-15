import { describe, expect, test } from "vitest";

import {
  OPENAI_LIGHT_OUTPUT_ENV,
  OPENAI_LIGHT_OUTPUT_SWITCHES,
  openAiLightOutputEnabled,
  openAiLightOutputSwitches,
} from "../../src/llm/openai-light-output.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { buildOpenAIResponsesRequest } from "../../src/llm/wire/responses-openai.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS } from "../../src/app-server/protocol/index.js";

const env = (value: string) => ({ [OPENAI_LIGHT_OUTPUT_ENV]: value });

function sessionFor(provider: string, providerEnvironment: Record<string, string>, lightMode = true) {
  return {
    conversationId: "light-output",
    config: { model: "gpt-6.1-terra" },
    services: { provider: { name: provider }, runtimeOptions: { lightMode }, providerEnvironment },
  };
}

function optionsFor(provider: string, providerEnvironment: Record<string, string>, context: Record<string, unknown>, lightMode = true) {
  const { signal: _signal, ...rest } = buildProviderOptions(
    { tools: [], parallelToolCalls: false, baseInstructions: "SYSTEM" } as never,
    { modelInfo: { slug: "gpt-6.1-terra" }, ...context } as never,
    new AbortController().signal,
    sessionFor(provider, providerEnvironment, lightMode) as never,
  );
  return rest;
}

function execCommand(provider: string, providerEnvironment: Record<string, string>, lightMode = true) {
  const registry = buildToolRegistry({
    workspaceRoot: "/tmp", lightMode, deferRareTools: true, requireAdmission: false,
    getSession: () => sessionFor(provider, providerEnvironment, lightMode) as never,
  });
  return { registry, tool: () => registry.toLLMTools().find((tool) => tool.function.name === "exec_command")! };
}

describe("AGENC_OPENAI_LIGHT_OUTPUT", () => {
  test("names its switches one by one, or all, for the openai provider only", () => {
    expect([...openAiLightOutputSwitches(undefined, "openai")]).toEqual([]);
    expect([...openAiLightOutputSwitches({}, "openai")]).toEqual([]);
    expect([...openAiLightOutputSwitches(env(" "), "openai")]).toEqual([]);
    expect([...openAiLightOutputSwitches(env("exec-args"), "openai")]).toEqual(["exec-args"]);
    expect([...openAiLightOutputSwitches(env(" No-Summary , unknown"), "openai")]).toEqual(["no-summary"]);
    expect([...openAiLightOutputSwitches(env("all"), "openai")]).toEqual([...OPENAI_LIGHT_OUTPUT_SWITCHES]);
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic", undefined]) {
      expect([...openAiLightOutputSwitches(env("all"), provider)], String(provider)).toEqual([]);
      expect(openAiLightOutputEnabled(env("all"), provider, "exec-args")).toBe(false);
    }
  });

  test("reaches the daemon from the client environment", () => {
    expect(AGENC_DAEMON_CLIENT_ENV_KEYS).toContain(OPENAI_LIGHT_OUTPUT_ENV);
  });
});

describe("no-summary", () => {
  const byDefault = { reasoningSummary: "auto", reasoningSummaryIsDefault: true };

  test("a Light session on openai asks for no summary unless the user chose one", () => {
    expect(optionsFor("openai", env("no-summary"), byDefault)).toMatchObject({ reasoningSummary: "none" });
    expect("reasoningSummaryIsDefault" in optionsFor("openai", env("no-summary"), byDefault)).toBe(false);
    expect(optionsFor("openai", env("no-summary"), { reasoningSummary: "detailed" })).toMatchObject({ reasoningSummary: "detailed" });
  });

  test("nothing changes without the switch, outside Light or for another provider", () => {
    const base = optionsFor("openai", {}, byDefault);
    expect(base).toMatchObject({ reasoningSummary: "auto", reasoningSummaryIsDefault: true });
    expect(optionsFor("openai", env("exec-args"), byDefault)).toEqual(base);
    expect(optionsFor("openai", env("all"), byDefault, false)).toEqual(optionsFor("openai", {}, byDefault, false));
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic"]) {
      expect(optionsFor(provider, env("all"), byDefault), provider).toEqual(optionsFor(provider, {}, byDefault));
    }
  });

  test("the ChatGPT backend request then carries the effort and the encrypted replay, without a summary", () => {
    const request = {
      model: "gpt-6.1-terra", chatgptBackend: true, reasoningReplayProvider: "openai",
      messages: [{ role: "user" as const, content: "Read the project." }], tools: [],
    };
    const before = buildOpenAIResponsesRequest({ ...request, options: { reasoningEffort: "medium", ...byDefault } as never });
    const after = buildOpenAIResponsesRequest({ ...request, options: { reasoningEffort: "medium", reasoningSummary: "none" } });
    expect(before.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(after.reasoning).toEqual({ effort: "medium" });
    expect(after.include).toEqual(["reasoning.encrypted_content"]);
    expect({ ...after, reasoning: before.reasoning }).toEqual(before);
  });
});

describe("exec-args", () => {
  test("a Light session on openai lists cmd and timeoutMs and says where the command runs", () => {
    const { tool } = execCommand("openai", env("exec-args"));
    expect(Object.keys(tool().function.parameters.properties as object).sort()).toEqual(["cmd", "timeoutMs"]);
    expect(tool().function.parameters.required).toEqual(["cmd"]);
    expect(tool().function.description).toContain("Runs in the workspace root.");
    expect(tool().function.description).toContain("Advanced fields (workdir, background,");
  });

  test("the hidden fields load with the full schema and are still accepted", () => {
    const { registry, tool } = execCommand("openai", env("exec-args"));
    const canonical = registry.tools.find((candidate) => candidate.name === "exec_command")!;
    registry.discoverToolNames?.(["exec_command"]);
    expect(Object.keys(tool().function.parameters.properties as object).sort())
      .toEqual(Object.keys(canonical.inputSchema.properties!).sort());
    expect(Object.keys(canonical.inputSchema.properties!)).toEqual(expect.arrayContaining(["workdir", "background"]));
  });

  test("nothing changes without the switch, outside Light or for another provider", () => {
    const base = execCommand("openai", {}).tool();
    expect(Object.keys(base.function.parameters.properties as object).sort()).toEqual(["background", "cmd", "timeoutMs", "workdir"]);
    expect(execCommand("openai", env("no-summary")).tool()).toEqual(base);
    expect(execCommand("openai", env("all"), false).tool()).toEqual(execCommand("openai", {}, false).tool());
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic"]) {
      expect(execCommand(provider, env("all")).registry.toLLMTools(), provider)
        .toEqual(execCommand(provider, {}).registry.toLLMTools());
    }
  });
});
