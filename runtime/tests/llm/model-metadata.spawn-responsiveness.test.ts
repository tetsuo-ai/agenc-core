import { afterEach, expect, it, vi } from "vitest";
import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import type { AgenCConfig } from "../../src/config/schema.js";

afterEach(() => vi.unstubAllEnvs());

it("reads the saved OpenRouter key once when building the spawn model list", () => {
  const readSavedApiKey = vi.fn(() => undefined);
  const manager = new StaticModelsManager({ config: { model_provider: "deepseek" } as AgenCConfig,
    metadata: { env: {}, readSavedApiKey } });
  const models = manager.tryListModels();
  expect(models?.some(model => model.slug === "deepseek-flash")).toBe(true);
  expect(readSavedApiKey.mock.calls.length).toBeLessThanOrEqual(1);
});

it("does not reread credentials whose value the existing catalog will not use", () => {
  const readSavedApiKey = vi.fn(() => "fixture-key");
  const resolver = new ModelMetadataResolver({ env: {}, readSavedApiKey });
  resolver.readOpenRouterCatalog();
  resolver.readOpenRouterCatalog();
  resolver.readOpenRouterCatalog();
  expect(readSavedApiKey).toHaveBeenCalledTimes(1);
});

it("retains the old lookup behavior behind the diagnostic opt-out", () => {
  const readSavedApiKey = vi.fn(() => undefined);
  vi.stubEnv("AGENC_SPAWN_RESPONSIVENESS", "off");
  const resolver = new ModelMetadataResolver({ env: {}, readSavedApiKey });
  resolver.readOpenRouterCatalog(); resolver.readOpenRouterCatalog();
  expect(readSavedApiKey).toHaveBeenCalledTimes(2);
});
