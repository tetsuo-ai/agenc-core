import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelMetadataResolver } from "../model-metadata.js";
import { ensureOpenRouterZdrEndpoints } from "../../commands/live-model-catalog.js";
import type { SlashCommandContext } from "../../commands/types.js";

import {
  isOpenRouterRouterModel,
  openRouterModelHasZdrEndpoint,
  openRouterZdrEndpointsKnown,
  OPENROUTER_ZDR_ENDPOINTS_URL,
  recordOpenRouterZdrEndpoints,
  resetOpenRouterZdrEndpointsForTesting,
} from "./openrouter-zdr-endpoints.js";

/** Entries in the shape GET /api/v1/endpoints/zdr returned on 2026-10-22. */
function endpoint(modelId: string, provider: string, tag: string): Record<string, unknown> {
  return {
    name: `${provider} | ${modelId}`,
    model_id: modelId,
    model_name: modelId,
    context_length: 131072,
    pricing: { prompt: "0.0000003", completion: "0.0000012" },
    provider_name: provider,
    tag,
    quantization: "fp8",
    status: 0,
  };
}

const LIST = {
  data: [
    endpoint("deepseek/deepseek-v4.1-flash", "Relace", "relace"),
    endpoint("deepseek/deepseek-v4.1-flash", "Fireworks", "fireworks"),
    endpoint("anthropic/claude-sonnet-5.5", "Google", "google-vertex/us"),
    endpoint("baseten/mammoth-1:free", "BaseTen", "baseten"),
  ],
};

afterEach(() => resetOpenRouterZdrEndpointsForTesting());

describe("OpenRouter zero-retention endpoint list", () => {
  it("reads the public list without a key", () => {
    expect(OPENROUTER_ZDR_ENDPOINTS_URL).toBe("https://openrouter.ai/api/v1/endpoints/zdr");
  });

  it("answers nothing before the list is read", () => {
    expect(openRouterZdrEndpointsKnown()).toBe(false);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash")).toBeUndefined();
  });

  it("knows which models have at least one zero-retention endpoint", () => {
    expect(recordOpenRouterZdrEndpoints(LIST)).toBe(true);
    expect(openRouterZdrEndpointsKnown()).toBe(true);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(openRouterModelHasZdrEndpoint("anthropic/claude-sonnet-5.5")).toBe(true);
    expect(openRouterModelHasZdrEndpoint("google/gemini-2.5-flash")).toBe(false);
    expect(openRouterModelHasZdrEndpoint(" deepseek/deepseek-v4.1-flash ")).toBe(true);
  });

  it("answers for sorting variants with the base model, and not for free or web variants", () => {
    recordOpenRouterZdrEndpoints(LIST);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash:nitro")).toBe(true);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash:floor")).toBe(true);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash:exacto")).toBe(true);
    // Free endpoints are listed on their own; web search plugins are outside ZDR.
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash:free")).toBe(false);
    expect(openRouterModelHasZdrEndpoint("baseten/mammoth-1:free")).toBe(true);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash:online")).toBe(false);
  });

  it("leaves router and alias ids to OpenRouter's own filter", () => {
    recordOpenRouterZdrEndpoints(LIST);
    for (const id of ["openrouter/auto", "openrouter/free", "~z-ai/glm-latest"]) {
      expect(isOpenRouterRouterModel(id), id).toBe(true);
      expect(openRouterModelHasZdrEndpoint(id), id).toBeUndefined();
    }
    expect(isOpenRouterRouterModel("z-ai/glm-5.3")).toBe(false);
  });

  it("keeps the last good list when an answer is not the list", () => {
    recordOpenRouterZdrEndpoints(LIST);
    for (const body of [undefined, null, {}, { data: [] }, { data: [{ model_id: 7 }] }, "<html>"]) {
      expect(recordOpenRouterZdrEndpoints(body)).toBe(false);
    }
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash")).toBe(true);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function commandContext(config: Record<string, unknown> = {}): SlashCommandContext {
  return {
    session: { services: { configStore: { current: () => config }, providerEnvironment: {} } },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  } as unknown as SlashCommandContext;
}

describe("reading the list", () => {
  it("records the public list through the metadata resolver", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(LIST));
    expect(await new ModelMetadataResolver({ fetchImpl }).discoverOpenRouterZdrEndpoints()).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(OPENROUTER_ZDR_ENDPOINTS_URL);
    expect(openRouterModelHasZdrEndpoint("anthropic/claude-sonnet-5.5")).toBe(true);
  });

  it("is read for the TUI only while requests ask for zero data retention", async () => {
    const off = vi.fn<typeof fetch>().mockResolvedValue(json(LIST));
    expect(await ensureOpenRouterZdrEndpoints(
      commandContext({ providers: { openrouter: { zero_data_retention: false } } }),
      { fetchImpl: off },
    )).toBe(true);
    expect(off).not.toHaveBeenCalled();
    expect(openRouterZdrEndpointsKnown()).toBe(false);

    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 503 }));
    expect(await ensureOpenRouterZdrEndpoints(commandContext(), { fetchImpl: failing })).toBe(false);
    expect(openRouterZdrEndpointsKnown()).toBe(false);

    const on = vi.fn<typeof fetch>().mockResolvedValue(json(LIST));
    expect(await ensureOpenRouterZdrEndpoints(commandContext(), { fetchImpl: on })).toBe(true);
    expect(on).toHaveBeenCalledTimes(1);
    expect(openRouterModelHasZdrEndpoint("deepseek/deepseek-v4.1-flash")).toBe(true);
  });
});
