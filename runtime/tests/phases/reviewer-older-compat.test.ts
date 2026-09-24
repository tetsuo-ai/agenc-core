// Adopted from the independent PR 2641 re-review regression.
import { beforeEach, expect, it, vi } from "vitest";
import { ModelRegistry, modelRegistryEntryToModelInfo } from "../../src/llm/model-registry.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { resolveSessionReasoningEffort } from "../../src/phases/stream-model.js";
import { buildAnthropicMessagesRequest } from "../../src/llm/wire/messages-anthropic.js";

const settings = vi.hoisted(() => ({
  effort: undefined as "max" | "xhigh" | undefined,
}));
vi.mock("../../src/utils/effort.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/utils/effort.js")>(),
  getInitialEffortSetting: () => settings.effort,
}));
beforeEach(() => { settings.effort = undefined; });

const models = ["claude-opus-4-6", "claude-sonnet-4-6"] as const;

it.each(models)("preserves main request effort for configured max on %s", (model) => {
  const row = { provider: "anthropic", model };
  const registry = new ModelRegistry({ config: {} });
  const info = modelRegistryEntryToModelInfo(registry.resolveSync(row));
  const seed = sessionConfigurationFromAgenCConfig({
    config: { reasoning_effort: "max" }, workspaceRoot: process.cwd(), ...row,
  }).collaborationMode.reasoningEffort;
  const effort = resolveSessionReasoningEffort(seed, info.supportedReasoningLevels, row);
  const body = buildAnthropicMessagesRequest({
    model, messages: [], tools: [], maxTokens: 4096, options: { reasoningEffort: effort },
  });
  expect(body.thinking).toEqual({ type: "adaptive" });
  expect(body.output_config).toEqual({ effort: "high" });
});

it.each(models.flatMap(model =>
  (["configured", "persisted"] as const).flatMap(source =>
    (["max", "xhigh"] as const).map(requested => ({ model, source, requested }))),
))("matches main's full body for $source $requested on $model", ({ model, source, requested }) => {
  const row = { provider: "anthropic", model };
  const registry = new ModelRegistry({ config: {} });
  const info = modelRegistryEntryToModelInfo(registry.resolveSync(row));
  if (source === "persisted") settings.effort = requested;
  const seed = sessionConfigurationFromAgenCConfig({
    config: source === "configured" ? { reasoning_effort: requested } : {},
    workspaceRoot: process.cwd(), ...row,
  }).collaborationMode.reasoningEffort;
  expect(seed).toBe(source === "configured" ? "xhigh" : undefined);
  const effort = resolveSessionReasoningEffort(seed, info.supportedReasoningLevels, row);
  expect(buildAnthropicMessagesRequest({
    model, messages: [], tools: [], maxTokens: 4096, options: { reasoningEffort: effort },
  })).toEqual({
    model, messages: [], max_tokens: 4096,
    thinking: { type: "adaptive" }, output_config: { effort: "high" },
  });
});
