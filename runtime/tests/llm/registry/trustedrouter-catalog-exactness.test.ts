/**
 * Every TrustedRouter public chat model and alias AgenC lists carries
 * TrustedRouter's published row accurately: context window, completion limit,
 * vision, tool support, reasoning/efforts, structured output, ZDR, and pricing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  TRUSTEDROUTER_MODELS,
  parseTrustedRouterModels,
  trustedRouterCatalogEntry,
} from "../../../src/llm/registry/trustedrouter-models.js";

interface Row {
  readonly id: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly supports_chat?: boolean;
  readonly architecture?: { readonly input_modalities?: readonly string[] };
  readonly top_provider?: {
    readonly context_length?: number;
    readonly max_completion_tokens?: number | null;
  };
  readonly supported_parameters?: readonly string[];
  readonly reasoning?: {
    readonly mandatory?: boolean;
    readonly default_enabled?: boolean;
    readonly supported_efforts?: readonly string[];
    readonly default_effort?: string | null;
  } | null;
  readonly pricing?: {
    readonly prompt?: string;
    readonly completion?: string;
    readonly input_cache_read?: string;
  };
  readonly trustedrouter?: {
    readonly aliases?: readonly string[];
    readonly internal_only?: boolean;
    readonly configuration_hidden?: boolean;
    readonly synthetic_monitor?: boolean;
    readonly supports_chat?: boolean;
    readonly privacy_tier?: number;
    readonly provider_zero_data_retention?: boolean;
    readonly capabilities?: {
      readonly tools?: boolean;
      readonly vision?: boolean;
      readonly reasoning_effort?: readonly string[] | null;
    } | null;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/trustedrouter-models.json", import.meta.url), "utf8"),
) as { readonly data: readonly Row[] };

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const listed = fixture.data.filter((row) => {
  const tr = row.trustedrouter;
  return (
    tr?.internal_only !== true &&
    tr?.configuration_hidden !== true &&
    tr?.synthetic_monitor !== true &&
    tr?.supports_chat !== false &&
    row.supports_chat !== false
  );
});
const parsed = new Map(
  parseTrustedRouterModels(fixture).map((model) => [model.model, model]),
);

describe("every TrustedRouter public chat model's AgenC entry matches its published row", () => {
  test("every bundled fallback row matches its live counterpart", () => {
    for (const row of TRUSTEDROUTER_MODELS) {
      expect(row).toEqual(parsed.get(row.model));
    }
  });

  test("exposes all filtered public chat rows plus their unique aliases", () => {
    expect(listed.length).toBeGreaterThan(450);
    const canonicalIds = new Set(listed.map((row) => row.id));
    const expectedIds = new Set(canonicalIds);
    for (const row of listed) {
      for (const alias of row.trustedrouter?.aliases ?? []) {
        if (!canonicalIds.has(alias)) expectedIds.add(alias);
      }
    }
    expect([...parsed.keys()].sort()).toEqual([...expectedIds].sort());
  });

  test("maps limits, modalities, capabilities, efforts, and pricing for every listed row", () => {
    for (const row of listed) {
      const model = parsed.get(row.id)!;
      expect(model, row.id).toBeDefined();
      const entry = trustedRouterCatalogEntry(model, 0);
      const tr = row.trustedrouter;
      const caps = tr?.capabilities;
      const params = row.supported_parameters ?? [];
      const expectedContext =
        typeof row.context_length === "number" && row.context_length > 0
          ? row.context_length
          : typeof row.top_provider?.context_length === "number" &&
              row.top_provider.context_length > 0
            ? row.top_provider.context_length
            : undefined;
      const expectedOutput =
        typeof row.top_provider?.max_completion_tokens === "number" &&
        row.top_provider.max_completion_tokens > 0
          ? row.top_provider.max_completion_tokens
          : undefined;
      expect(entry.contextWindow, row.id).toBe(expectedContext);
      expect(entry.maxOutputTokens, row.id).toBe(expectedOutput);
      expect(entry.supportsToolUse, row.id).toBe(
        caps?.tools === true || params.includes("tools"),
      );
      expect(entry.inputModalities.includes("image"), row.id).toBe(
        caps?.vision === true ||
          (row.architecture?.input_modalities ?? []).includes("image"),
      );
      expect(entry.supportsStructuredOutput, row.id).toBe(
        params.includes("structured_outputs") || params.includes("response_format"),
      );

      const rawEfforts = Array.isArray(caps?.reasoning_effort)
        ? caps.reasoning_effort
        : row.reasoning?.supported_efforts ?? [];
      const expectedEfforts = [...new Set(rawEfforts.filter((e) => EFFORTS.includes(e)))];
      expect(entry.supportedReasoningLevels, row.id).toEqual(expectedEfforts);

      if (row.pricing?.prompt !== undefined && row.pricing?.completion !== undefined) {
        expect(model.cost?.inputUsdPer1K, row.id).toBeCloseTo(
          Number(row.pricing.prompt) * 1000,
          12,
        );
        expect(model.cost?.outputUsdPer1K, row.id).toBeCloseTo(
          Number(row.pricing.completion) * 1000,
          12,
        );
        if (row.pricing.input_cache_read !== undefined) {
          expect(model.cost?.cachedInputUsdPer1K, row.id).toBeCloseTo(
            Number(row.pricing.input_cache_read) * 1000,
            12,
          );
        }
      }
    }
  });
});
