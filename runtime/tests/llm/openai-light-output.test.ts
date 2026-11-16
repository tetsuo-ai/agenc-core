import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  OPENAI_LIGHT_OUTPUT_DEFAULTS,
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
    expect([...openAiLightOutputSwitches(env("exec-args"), "openai")]).toEqual(["exec-args"]);
    expect([...openAiLightOutputSwitches(env(" No-Summary , unknown"), "openai")]).toEqual(["exec-args", "no-summary"]);
    expect([...openAiLightOutputSwitches(env("all"), "openai")]).toEqual([...OPENAI_LIGHT_OUTPUT_SWITCHES]);
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic", undefined]) {
      expect([...openAiLightOutputSwitches(env("all"), provider)], String(provider)).toEqual([]);
      expect(openAiLightOutputEnabled(env("all"), provider, "exec-args")).toBe(false);
    }
  });

  test("exec-args is on by default; off turns the defaults off and keeps what is named beside it", () => {
    expect(OPENAI_LIGHT_OUTPUT_DEFAULTS).toEqual(["exec-args"]);
    for (const unset of [undefined, {}, env(""), env(" "), env("unknown"), env("on")]) {
      expect([...openAiLightOutputSwitches(unset, "openai")], JSON.stringify(unset)).toEqual(["exec-args"]);
    }
    for (const off of ["off", " OFF ", "none", "0", "false", "no"]) {
      expect([...openAiLightOutputSwitches(env(off), "openai")], off).toEqual([]);
    }
    expect([...openAiLightOutputSwitches(env("off,no-summary"), "openai")]).toEqual(["no-summary"]);
    expect([...openAiLightOutputSwitches(env("no-summary, off"), "openai")]).toEqual(["no-summary"]);
    expect([...openAiLightOutputSwitches(env("off,exec-args"), "openai")]).toEqual(["exec-args"]);
    expect([...openAiLightOutputSwitches(env("off,all"), "openai")]).toEqual([...OPENAI_LIGHT_OUTPUT_SWITCHES]);
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic", undefined]) {
      expect([...openAiLightOutputSwitches(undefined, provider)], String(provider)).toEqual([]);
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
    expect(optionsFor("openai", env("off"), byDefault)).toEqual(base);
    expect(optionsFor("openai", env("off,no-summary"), byDefault)).toMatchObject({ reasoningSummary: "none" });
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
  test("a Light session on openai lists cmd and timeoutMs by default and says where the command runs", () => {
    const { tool } = execCommand("openai", {});
    expect(execCommand("openai", env("exec-args")).tool()).toEqual(tool());
    expect(execCommand("openai", env("no-summary")).tool()).toEqual(tool());
    expect(execCommand("openai", env("all")).tool()).toEqual(tool());
    expect(Object.keys(tool().function.parameters.properties as object).sort()).toEqual(["cmd", "timeoutMs"]);
    expect(tool().function.parameters.required).toEqual(["cmd"]);
    expect(tool().function.description).toContain("Runs in the workspace root.");
    expect(tool().function.description).toContain("Advanced fields (workdir, background,");
  });

  test("the hidden fields load with the full schema and are still accepted", () => {
    const { registry, tool } = execCommand("openai", {});
    const canonical = registry.tools.find((candidate) => candidate.name === "exec_command")!;
    registry.discoverToolNames?.(["exec_command"]);
    expect(Object.keys(tool().function.parameters.properties as object).sort())
      .toEqual(Object.keys(canonical.inputSchema.properties!).sort());
    expect(Object.keys(canonical.inputSchema.properties!)).toEqual(expect.arrayContaining(["workdir", "background"]));
  });

  test("off brings back the four fields of 0.19.35, also next to no-summary", () => {
    const off = execCommand("openai", env("off")).tool();
    expect(Object.keys(off.function.parameters.properties as object).sort()).toEqual(["background", "cmd", "timeoutMs", "workdir"]);
    expect(off.function.description).not.toContain("Runs in the workspace root.");
    expect(off.function.description).toContain("Advanced fields (yield_time_ms,");
    expect(execCommand("openai", env("off,no-summary")).tool()).toEqual(off);
    // Another provider's Light exec_command is the one `off` restores on openai.
    expect(execCommand("grok", {}).tool()).toEqual(off);
  });

  test("off sends the Light catalog of 0.19.35 byte for byte", () => {
    // The gpt-6-luna Light catalog pinned by tests/tool-registry.edit-then-run.test.ts up to 0.19.35.
    const catalog = (providerEnvironment: Record<string, string>) => JSON.stringify(buildToolRegistry({
      workspaceRoot: "/workspace", lightMode: true,
      getSession: () => ({ services: { runtimeOptions: { lightMode: true }, providerEnvironment,
        provider: { name: "openai" }, providerService: { current: () => ({ provider: "openai", model: "gpt-6-luna" }) } } }) as never,
    }).toLLMTools());
    const off = catalog(env("off"));
    expect([Buffer.byteLength(off), createHash("sha256").update(off).digest("hex")])
      .toEqual([2347, "df9bdc4d9db2110045dc89dd6c428377a6ad9df87aeca71f9fd9425dac7879d7"]);
    expect(Buffer.byteLength(catalog({}))).toBe(2295);
  });

  test("nothing changes outside Light or for another provider, whatever the variable says", () => {
    const standard = execCommand("openai", env("off"), false).registry.toLLMTools();
    for (const value of [undefined, "exec-args", "all"]) {
      expect(execCommand("openai", value === undefined ? {} : env(value), false).registry.toLLMTools(), String(value)).toEqual(standard);
    }
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic"]) {
      const base = execCommand(provider, env("off")).registry.toLLMTools();
      expect(JSON.stringify(base), provider).not.toContain("Runs in the workspace root.");
      for (const value of [undefined, "exec-args", "all"]) {
        expect(execCommand(provider, value === undefined ? {} : env(value)).registry.toLLMTools(), `${provider} ${value}`).toEqual(base);
      }
    }
  });
});
