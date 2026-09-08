import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { resolveProviderModelCapabilities } from "../../src/llm/capabilities.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { defaultConfig } from "../../src/config/schema.js";
import { loadCanonicalConfig, loadCanonicalDaemonConfig } from "../../src/config/repository.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { createTokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { LLMChatOptions } from "../../src/llm/types.js";

const MODEL_LEVELS = [
  ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
  ["gemini-3.7-flash", ["low", "medium", "high"]],
  ["gemini-3.5-flash", ["minimal", "low", "medium", "high"]],
  ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
  ["gemini-3-pro-preview", ["low", "high"]],
  ["gemini-2.5-pro", []],
  ["gemini-2.5-flash", []],
  ["gemini-2.5-flash-lite", []],
] as const;
const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Gemini reasoning metadata", () => {
  test.each(MODEL_LEVELS)("shares exact %s levels without imposing a session default", async (model, levels) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })?.supportedReasoningLevels).toEqual(levels);
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsReasoningEffort).toBe(levels.length > 0);
    const manager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "gemini", model },
    });
    const info = await manager.getModelInfo(model);
    expect(info.supportedReasoningLevels).toEqual(levels);
    expect(info.defaultReasoningLevel).toBeUndefined();
  });

  test.each(["gemini-3.1-pro-preview-unverified", "gemini-3.5-flash-unverified"])("does not grant levels to %s", (model) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toBeUndefined();
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsReasoningEffort).toBe(false);
  });
});

describe.each(["chat", "stream", "count"] as const)("Gemini %s reasoning wire contract", (operation) => {
  async function request(model: string, effort: LLMChatOptions["reasoningEffort"]) {
    const payload = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => operation === "stream"
      ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json(operation === "count" ? { totalTokens: 1 } : payload));
    const provider = new GeminiProvider({
      model: "gemini-2.5-flash",
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" },
      fetchImpl,
    });
    const messages = [{ role: "user" as const, content: "fixture" }];
    const options = { model, reasoningEffort: effort };
    const result = operation === "chat" ? provider.chat(messages, options)
      : operation === "stream" ? provider.chatStream(messages, () => {}, options)
        : provider.tokenCountCapability.countTokens(createTokenAccountingRequest({ provider: "gemini", model, messages, options, reservedOutputTokens: 0 }), new AbortController().signal);
    return { result, fetchImpl };
  }

  for (const [model, levels] of MODEL_LEVELS) {
    for (const effort of levels) test(`${model} sends exact ${effort}`, async () => {
      const { result, fetchImpl } = await request(model, effort);
      await result;
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      const generationConfig = operation === "count" ? body.generateContentRequest.generationConfig : body.generationConfig;
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: effort });
    });

    test.each([undefined, "none"] as const)(`${model} omits thinking for %s`, async (effort) => {
      const { result, fetchImpl } = await request(model, effort);
      await result;
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      const generationConfig = operation === "count" ? body.generateContentRequest.generationConfig : body.generationConfig;
      expect(generationConfig).not.toHaveProperty("thinkingConfig");
    });
  }

  test.each([
    ["gemini-3.1-pro-preview", "minimal"],
    ["gemini-3.1-pro-preview", "xhigh"],
    ["gemini-3.1-pro-preview", "max"],
    ["gemini-3-pro-preview", "medium"],
    ["gemini-2.5-flash", "high"],
    ["gemini-3.1-pro-preview-unverified", "low"],
  ] as const)("rejects %s %s before transport", async (model, effort) => {
    const { result, fetchImpl } = await request(model, effort);
    await expect(result).rejects.toThrow(/reasoning effort/iu);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Gemini canonical effort configuration", () => {
  test.each([loadCanonicalConfig, loadCanonicalDaemonConfig])("preserves provider defaults and explicit settings through %s", async (load) => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-gemini-effort-"));
    DIRECTORIES.push(directory);
    const options = { home: directory, env: {}, managedConfigPath: join(directory, "managed.toml") };
    for (const effort of [undefined, "none", "low", "medium", "high"] as const) {
      writeFileSync(join(directory, "config.toml"), `config_version = 2\nmodel_provider = "gemini"\nmodel = "gemini-3.1-pro-preview"\n${effort === undefined ? "" : `reasoning_effort = "${effort}"\n`}`, { mode: 0o600 });
      const loaded = await load(options);
      expect(loaded.config.reasoning_effort).toBe(effort);
      expect(loaded.provenance.reasoning_effort?.scope).toBe(effort === undefined ? undefined : "user");
      const configuration = sessionConfigurationFromAgenCConfig({ config: loaded.config, workspaceRoot: directory, model: "gemini-3.1-pro-preview" });
      expect(configuration.collaborationMode.reasoningEffort).toBe(effort);
    }
    writeFileSync(join(directory, "config.toml"), 'config_version = 2\nmodel_provider = "grok"\n', { mode: 0o600 });
    expect((await load(options)).config.reasoning_effort).toBe("medium");
  });
});
