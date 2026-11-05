import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { LLMCapabilityError } from "../../src/llm/errors.js";
import { AbliterationProvider } from "../../src/llm/providers/abliteration/index.js";
import { VeniceProvider } from "../../src/llm/providers/venice/index.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";

afterEach(() => clearPublishedModelCatalogs());

test.each([
  { name: "abliteration", model: "fixture-locked-model" },
  { name: "venice", model: "deepseek-v4-flsh" },
])("rejects an unavailable $name model during existing profile discovery", async ({ name, model }) => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${name}-models.json`, import.meta.url), "utf8"));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  const provider = name === "venice"
    ? new VeniceProvider({ apiKey: "test-only", model, fetchImpl })
    : new AbliterationProvider({ apiKey: "test-only", model, fetchImpl });
  await expect(provider.getExecutionProfile({ model })).rejects.toBeInstanceOf(LLMCapabilityError);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/models$/);
});

test.each([
  { name: "abliteration", model: "abliterated-model-large-v2" },
  { name: "venice", model: "zai-org-glm-5-2" },
])("keeps $name discovery transport failure distinct from deterministic rejection", async ({ name, model }) => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("discovery transport unavailable"));
  const provider = name === "venice"
    ? new VeniceProvider({ apiKey: "test-only", model, fetchImpl })
    : new AbliterationProvider({ apiKey: "test-only", model, fetchImpl });
  await expect(provider.getExecutionProfile({ model })).resolves.toMatchObject({ provider: name, model });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/models$/);
});
