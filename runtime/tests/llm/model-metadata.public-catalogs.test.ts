import { describe, expect, test } from "vitest";

import {
  ModelMetadataResolver,
  PublicModelCatalogCache,
} from "../../src/llm/model-metadata.js";
import type { AgenCConfig } from "../../src/config/schema.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * A model no built-in table knows, from a provider without a live metadata
 * endpoint, so a lookup reaches models.dev and then the LiteLLM map.
 */
const LOOKUP = {
  provider: "anthropic",
  model: "unlisted-catalog-model",
  config: {} as unknown as AgenCConfig,
};

type Route = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Route {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function countingFetch(routes: Record<string, Route>): {
  readonly impl: typeof fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route === undefined
      ? new Response("not found", { status: 404 })
      : await route();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const LITELLM_ONLY = {
  [MODELS_DEV_URL]: json({}),
  [LITELLM_URL]: json({
    "unlisted-catalog-model": { max_input_tokens: 65_536, max_output_tokens: 8_192 },
  }),
};

function downloadsOf(calls: readonly string[], url: string): number {
  return calls.filter((call) => call === url).length;
}

describe("public model catalog downloads", () => {
  test("resolvers sharing a cache download each catalog once", async () => {
    const { impl, calls } = countingFetch(LITELLM_ONLY);
    const publicCatalogs = new PublicModelCatalogCache();
    const resolver = () =>
      new ModelMetadataResolver({ fetchImpl: impl, env: {}, publicCatalogs });

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => resolver().resolve(LOOKUP)),
    );
    const later = await resolver().resolve(LOOKUP);

    for (const resolved of [...concurrent, later]) {
      expect(resolved).toMatchObject({ contextWindow: 65_536, source: "litellm" });
    }
    expect(downloadsOf(calls, MODELS_DEV_URL)).toBe(1);
    expect(downloadsOf(calls, LITELLM_URL)).toBe(1);
  });

  test("lookups that start together share one request in flight", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { impl, calls } = countingFetch({
      [MODELS_DEV_URL]: async () => {
        await answered;
        return json({
          anthropic: {
            models: {
              "unlisted-catalog-model": { limit: { context: 32_768, output: 4_096 } },
            },
          },
        })();
      },
    });
    const publicCatalogs = new PublicModelCatalogCache();

    const pending = Array.from({ length: 3 }, () =>
      new ModelMetadataResolver({ fetchImpl: impl, env: {}, publicCatalogs }).resolve(
        LOOKUP,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer();

    for (const resolved of await Promise.all(pending)) {
      expect(resolved).toMatchObject({ contextWindow: 32_768, source: "models_dev" });
    }
    expect(calls).toEqual([MODELS_DEV_URL]);
  });

  test("a failed download is not kept, so the next lookup tries again", async () => {
    let attempts = 0;
    const { impl, calls } = countingFetch({
      [MODELS_DEV_URL]: () => {
        attempts += 1;
        return attempts === 1
          ? new Response("unavailable", { status: 503 })
          : json({
            anthropic: {
              models: {
                "unlisted-catalog-model": { limit: { context: 32_768 } },
              },
            },
          })();
      },
      [LITELLM_URL]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const publicCatalogs = new PublicModelCatalogCache();
    const resolver = () =>
      new ModelMetadataResolver({ fetchImpl: impl, env: {}, publicCatalogs });

    const first = await resolver().resolve(LOOKUP);
    const second = await resolver().resolve(LOOKUP);

    expect(first).toMatchObject({
      source: "conservative_fallback",
      usedFallbackModelMetadata: true,
    });
    expect(second).toMatchObject({ contextWindow: 32_768, source: "models_dev" });
    expect(downloadsOf(calls, MODELS_DEV_URL)).toBe(2);
  });

  test("a download is reused for the reuse window and fetched again after it", async () => {
    const { impl, calls } = countingFetch(LITELLM_ONLY);
    let now = 1_000;
    const publicCatalogs = new PublicModelCatalogCache({
      now: () => now,
      reuseMs: 60_000,
    });
    const resolve = () =>
      new ModelMetadataResolver({ fetchImpl: impl, env: {}, publicCatalogs }).resolve(
        LOOKUP,
      );

    await resolve();
    now += 59_999;
    await resolve();
    expect(downloadsOf(calls, LITELLM_URL)).toBe(1);
    now += 1;
    await resolve();
    expect(downloadsOf(calls, LITELLM_URL)).toBe(2);
    expect(downloadsOf(calls, MODELS_DEV_URL)).toBe(2);
  });

  test("resolvers without a shared cache keep downloading their own copy", async () => {
    const { impl, calls } = countingFetch(LITELLM_ONLY);

    for (let session = 0; session < 3; session += 1) {
      await new ModelMetadataResolver({ fetchImpl: impl, env: {} }).resolve(LOOKUP);
    }

    expect(downloadsOf(calls, MODELS_DEV_URL)).toBe(3);
    expect(downloadsOf(calls, LITELLM_URL)).toBe(3);
  });
});
