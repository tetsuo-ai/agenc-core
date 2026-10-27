/**
 * Every Venice text model AgenC lists carries Venice's published row exactly:
 * context, output limit, image input, thinking, effort levels and default,
 * structured output and prices (jobs/pv owner request, 2026-10-20). The
 * fixture is Venice's live GET /api/v1/models answer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  VENICE_MODELS,
  parseVeniceModels,
  veniceCatalogEntry,
  VENICE_TOOL_CALLS_NOT_DELIVERED,
} from "../../../src/llm/registry/venice-models.js";

interface Price { readonly usd: number }
interface Row {
  readonly id: string;
  readonly type: string;
  readonly model_spec: {
    readonly offline?: boolean;
    readonly availableContextTokens?: number;
    readonly maxCompletionTokens?: number;
    readonly pricing?: { readonly input?: Price; readonly output?: Price; readonly cache_input?: Price };
    readonly capabilities: {
      readonly supportsFunctionCalling?: boolean;
      readonly supportsVision?: boolean;
      readonly supportsReasoning?: boolean;
      readonly supportsReasoningEffort?: boolean;
      readonly reasoningEffortOptions?: readonly string[];
      readonly defaultReasoningEffort?: string;
      readonly supportsResponseSchema?: boolean;
    };
  };
}

const fixture = JSON.parse(readFileSync(new URL("../fixtures/venice-models.json", import.meta.url), "utf8")) as { readonly data: readonly Row[] };
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const listed = fixture.data.filter(row => row.type === "text" && row.model_spec.offline !== true &&
  row.model_spec.capabilities.supportsFunctionCalling === true && !VENICE_TOOL_CALLS_NOT_DELIVERED.has(row.id));
const parsed = new Map(parseVeniceModels(fixture).map(model => [model.model, model]));

describe("every Venice text model's AgenC entry is its published row", () => {
  test("every bundled fallback row still matches its live counterpart", () => {
    const live = new Map(parseVeniceModels(fixture).map(row => [row.model, row]));
    for (const row of VENICE_MODELS) expect(row).toEqual(live.get(row.model));
  });
  test("AgenC lists exactly Venice's tool-calling text models", () => {
    expect(listed.length).toBeGreaterThan(100);
    expect([...parsed.keys()].sort()).toEqual(listed.map(row => row.id).sort());
  });

  test.each(listed.map(row => [row.id, row] as const))("%s", (_id, row) => {
    const spec = row.model_spec;
    const caps = spec.capabilities;
    const model = parsed.get(row.id)!;
    const entry = veniceCatalogEntry(model, 0);
    expect(entry.contextWindow).toBe(spec.availableContextTokens);
    expect(entry.maxOutputTokens).toBe(spec.maxCompletionTokens);
    expect(entry.inputModalities.includes("image")).toBe(caps.supportsVision === true);
    expect(entry.supportsThinking).toBe(caps.supportsReasoning === true);
    const levels = caps.supportsReasoning === true && caps.supportsReasoningEffort === true
      ? (caps.reasoningEffortOptions ?? []).filter(level => EFFORTS.includes(level))
      : [];
    expect(entry.supportedReasoningLevels).toEqual(levels);
    expect(entry.defaultReasoningLevel).toBe(
      caps.defaultReasoningEffort !== undefined && levels.includes(caps.defaultReasoningEffort) ? caps.defaultReasoningEffort : undefined);
    expect(entry.supportsStructuredOutput).toBe(caps.supportsResponseSchema === true);
    const pricing = spec.pricing;
    if (pricing?.input !== undefined && pricing.output !== undefined) {
      expect(model.cost?.inputUsdPer1K).toBeCloseTo(pricing.input.usd / 1000, 12);
      expect(model.cost?.outputUsdPer1K).toBeCloseTo(pricing.output.usd / 1000, 12);
      if (pricing.cache_input !== undefined) expect(model.cost?.cachedInputUsdPer1K).toBeCloseTo(pricing.cache_input.usd / 1000, 12);
    } else {
      expect(model.cost).toBeUndefined();
    }
  });
});
