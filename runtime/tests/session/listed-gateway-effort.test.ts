/**
 * Ollama Cloud and Venice: a session sends the effort its status line shows,
 * chosen or default (jobs/pv, 2026-10-20). Fails on r4/pp df5d8e2bd, where a
 * session with no level sent nothing while the status line named the model's
 * default, and a level the model does not list went out and was stripped.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../src/utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => settings.value,
  getSettingsForSource: () => ({}),
  updateSettingsForSource: vi.fn(async () => ({ error: null })),
}));

import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { OLLAMA_CLOUD_MODELS } from "../../src/llm/registry/ollama-cloud-models.js";
import { ABLITERATION_MODELS } from "../../src/llm/registry/abliteration-models.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
import { resolveSessionReasoningEffort } from "../../src/session/session-reasoning-effort.js";
import type { ReasoningEffort } from "../../src/session/turn-context.js";
import { getSessionEffortLabelForContext, nativeEffortLabel } from "../../src/utils/effort.js";

const CHOICES = [undefined, "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What reaches the request: the wire layer drops a level the model does not list. */
function sent(provider: string, model: string, choice: ReasoningEffort | undefined, followsModelDefault = false) {
  const levels = resolveReasoningEffort({ provider, model }).levels;
  const wire = resolveSessionReasoningEffort(choice, levels as readonly ReasoningEffort[], {
    provider,
    model,
    ...(followsModelDefault ? { followsModelDefault } : {}),
  });
  return wire !== undefined && levels.includes(wire) ? wire : undefined;
}

function label(level: string | undefined): string | null {
  return level === undefined ? null : level === "none" ? "effort off" : `${nativeEffortLabel(level)} effort`;
}

function expectAgreement(provider: string, model: string) {
  const levels = resolveReasoningEffort({ provider, model }).levels;
  const choices = levels.includes("none") ? [...CHOICES, "none" as const] : CHOICES;
  for (const choice of choices) {
    const shown = getSessionEffortLabelForContext(model, choice as never, { provider } as never);
    expect(label(sent(provider, model, choice)), `${provider} ${model} ${choice ?? "unset"}`).toBe(shown);
  }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("Ollama Cloud and Venice send the effort the status line shows", () => {
  afterEach(() => {
    settings.value = {};
    clearPublishedModelCatalogs();
  });

  test("a session with no level sends the model's listed default", () => {
    expect(sent("ollama-cloud", "glm-5.2", undefined)).toBe("high");
    // DeepSeek through a gateway: DeepSeek's own default, not Ollama's published low.
    expect(sent("ollama-cloud", "deepseek-v4-pro:0813", undefined)).toBe("high");
    expect(sent("ollama-cloud", "gpt-oss:120b", undefined)).toBe("medium");
    expect(sent("ollama-cloud", "kimi-k3", undefined)).toBe("max");
    expect(sent("ollama-cloud", "gemma4:31b", undefined)).toBe("none");
    // A session that went back to the model default sends that default.
    expect(sent("ollama-cloud", "kimi-k3", undefined, true)).toBe("max");
    // The configured level still applies when the session has none of its own.
    settings.value = { reasoning_effort: "low" };
    expect(sent("ollama-cloud", "kimi-k3", undefined)).toBe("low");
    // A model that lists no levels gets nothing.
    settings.value = {};
    expect(sent("ollama-cloud", "minimax-m3.1-flash", undefined)).toBeUndefined();
  });

  test("a level the model does not list sends what the status line names instead", () => {
    expect(sent("ollama-cloud", "kimi-k2.6", "low")).toBe("high");
    expect(sent("ollama-cloud", "gemma4:31b", "medium")).toBe("none");
    expect(sent("ollama-cloud", "glm-5.3", "xhigh")).toBe("max");
    expect(sent("ollama-cloud", "gpt-oss:120b", "max")).toBe("high");
  });

  test("every bundled Ollama Cloud model, for every choice", () => {
    for (const { model } of OLLAMA_CLOUD_MODELS) expectAgreement("ollama-cloud", model);
  });

  test("abliteration.ai sends each model's own mode, for every choice", () => {
    expect(sent("abliteration", "abliterated-model-large-flash", undefined)).toBe("high");
    expect(sent("abliteration", "abliterated-model-large-flash", "none")).toBe("none");
    expect(sent("abliteration", "abliterated-model-large-flash", "low")).toBe("low");
    expect(sent("abliteration", "abliterated-model-large-flash", "max")).toBe("max");
    // Large v2 runs low, high and max; AgenC's default is high (the provider runs max unasked).
    expect(sent("abliteration", "abliterated-model-large-v2", undefined)).toBe("high");
    expect(sent("abliteration", "abliterated-model-large-v2", "medium")).toBe("high");
    expect(sent("abliteration", "abliterated-model-large-v2", "xhigh")).toBe("max");
    expect(sent("abliteration", "abliterated-model-large-v2", "low")).toBe("low");
    // Large runs high and max.
    expect(sent("abliteration", "abliterated-model-large", undefined)).toBe("high");
    expect(sent("abliteration", "abliterated-model-large", "low")).toBe("high");
    expect(sent("abliteration", "abliterated-model-large", "xhigh")).toBe("max");
    // The base model takes every level; unset leaves it at its native depth, and off is sent.
    expect(sent("abliteration", "abliterated-model", undefined)).toBeUndefined();
    expect(sent("abliteration", "abliterated-model", "minimal")).toBe("minimal");
    expect(sent("abliteration", "abliterated-model", "none")).toBe("none");
    for (const model of ABLITERATION_MODELS) expectAgreement("abliteration", model.model);
  });

  test("Venice models from the live list, for every choice", async () => {
    const spec = (name: string, capabilities: Record<string, unknown>) => ({
      name, offline: false, availableContextTokens: 256000, maxCompletionTokens: 8192,
      pricing: { input: { usd: 0.12 }, output: { usd: 0.36 } },
      capabilities: { supportsFunctionCalling: true, ...capabilities },
    });
    const list = { data: [
      { id: "regression-venice-low-default", type: "text", model_spec: spec("Low Default", {
        supportsReasoning: true, supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "medium", "high"], defaultReasoningEffort: "low" }) },
      { id: "regression-venice-max-default", type: "text", model_spec: spec("Max Default", {
        supportsReasoning: true, supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "high", "max"], defaultReasoningEffort: "high" }) },
      { id: "regression-venice-no-levels", type: "text", model_spec: spec("No Levels", { supportsReasoning: true }) },
      { id: "deepseek-v4-pro", type: "text", model_spec: spec("DeepSeek V4 Pro", {
        supportsReasoning: true, supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "medium", "high"], defaultReasoningEffort: "low" }) },
    ] };
    await new ModelMetadataResolver({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json(list)),
      env: { VENICE_API_KEY: "fixture" },
    }).discoverVeniceModels({});
    expect(sent("venice", "regression-venice-low-default", undefined)).toBe("low");
    expect(sent("venice", "regression-venice-max-default", undefined)).toBe("high");
    expect(sent("venice", "regression-venice-max-default", "medium")).toBe("high");
    expect(sent("venice", "regression-venice-no-levels", undefined)).toBeUndefined();
    // Venice lists low for DeepSeek V4 Pro; DeepSeek's own default, high, applies.
    expect(sent("venice", "deepseek-v4-pro", undefined)).toBe("high");
    expect(sent("venice", "deepseek-v4-pro", "none")).toBe("none");
    for (const entry of list.data) expectAgreement("venice", entry.id);
  });
});
