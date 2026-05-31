/**
 * Regression tests for the grok reasoning_effort capability gate.
 *
 * Bug: spawning a subagent with effort=high on grok-4.3 threw
 * "xAI reasoning_effort is only supported on grok-4.20-multi-agent models".
 *
 * Root cause: the capability stub `resolveGrokReasoningEffort` always
 * returned false, so inherited effort was never stripped, and the grok
 * adapter then THREW (instead of omitting the field) for unsupported
 * models. These tests pin the strip-not-throw behavior across the
 * capability resolver, the responses-xai wire builder, and the adapter.
 *
 * @module
 */

import { describe, expect, it } from "vitest";

import { resolveProviderModelCapabilities } from "./capabilities.js";
import { supportsXaiReasoningEffortParam } from "./structured-output.js";
import { buildXaiResponsesRequest } from "./wire/responses-xai.js";
import { GrokProvider } from "./providers/grok/adapter.js";
import type { LLMMessage } from "./types.js";

const USER_TURN: readonly LLMMessage[] = [{ role: "user", content: "hi" }];

type BuildParamsAccess = {
  buildParams: (
    messages: readonly LLMMessage[],
    options?: Record<string, unknown>,
  ) => { params: Record<string, unknown> };
};

describe("grok reasoning_effort capability gate", () => {
  it("predicate: grok-4.3 rejects the param, grok-4.20-multi-agent accepts it", () => {
    expect(supportsXaiReasoningEffortParam("grok-4.3")).toBe(false);
    expect(supportsXaiReasoningEffortParam("grok-4.20-multi-agent")).toBe(
      true,
    );
  });

  it("capability resolver: acceptsReasoningEffort tracks the model", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "grok",
        model: "grok-4.3",
      }).acceptsReasoningEffort,
    ).toBe(false);

    expect(
      resolveProviderModelCapabilities({
        provider: "grok",
        model: "grok-4.20-multi-agent",
      }).acceptsReasoningEffort,
    ).toBe(true);
  });

  it("wire builder: omits reasoning for grok-4.3 with effort set", () => {
    const params = buildXaiResponsesRequest({
      model: "grok-4.3",
      messages: USER_TURN,
      options: { reasoningEffort: "high" },
    });
    expect(params.reasoning).toBeUndefined();
  });

  it("wire builder: attaches reasoning for grok-4.20-multi-agent", () => {
    const params = buildXaiResponsesRequest({
      model: "grok-4.20-multi-agent",
      messages: USER_TURN,
      options: { reasoningEffort: "high" },
    });
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("adapter: omits reasoning_effort for grok-4.3 with effort set (no throw)", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.3",
      reasoningEffort: "high",
    });

    // `buildParams` is private; exercise the real request-shaping path
    // directly so we assert the strip-not-throw behavior without a network
    // round-trip.
    const built = (provider as unknown as BuildParamsAccess).buildParams(
      USER_TURN,
      { reasoningEffort: "high" },
    );

    expect(built.params.reasoning).toBeUndefined();
    expect(built.params.model).toBe("grok-4.3");
  });

  it("adapter: attaches reasoning_effort for grok-4.20-multi-agent", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4.20-multi-agent",
      reasoningEffort: "high",
    });

    const built = (provider as unknown as BuildParamsAccess).buildParams(
      USER_TURN,
      { reasoningEffort: "high" },
    );

    expect(built.params.reasoning).toEqual({ effort: "high" });
  });
});
