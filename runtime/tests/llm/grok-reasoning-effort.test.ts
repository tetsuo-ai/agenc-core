/**
 * Regression tests for the grok reasoning_effort capability gate.
 *
 * These tests pin xAI's documented Grok 4.3/4.5 reasoning-depth controls
 * across the capability resolver, Responses API wire builder, and adapter,
 * while preserving fail-closed stripping for unknown models.
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
const DEPTH_EFFORTS = ["low", "medium", "high"] as const;

type BuildParamsAccess = {
  buildParams: (
    messages: readonly LLMMessage[],
    options?: Record<string, unknown>,
  ) => { params: Record<string, unknown> };
};

describe("grok reasoning_effort capability gate", () => {
  it("predicate: accepts documented depth and multi-agent models only", () => {
    expect(supportsXaiReasoningEffortParam("grok-4.3")).toBe(true);
    expect(supportsXaiReasoningEffortParam("grok-4.5")).toBe(true);
    expect(supportsXaiReasoningEffortParam("grok-4.5-latest")).toBe(true);
    expect(supportsXaiReasoningEffortParam("x-ai/grok-4.5")).toBe(true);
    expect(supportsXaiReasoningEffortParam("grok-build-latest")).toBe(true);
    expect(supportsXaiReasoningEffortParam("grok-4.20-multi-agent")).toBe(
      true,
    );
    expect(supportsXaiReasoningEffortParam("grok-build-0.1")).toBe(false);
    expect(
      supportsXaiReasoningEffortParam("grok-4.20-0309-non-reasoning"),
    ).toBe(false);
  });

  it("capability resolver: acceptsReasoningEffort tracks the model", () => {
    expect(
      resolveProviderModelCapabilities({
        provider: "grok",
        model: "grok-4.3",
      }).acceptsReasoningEffort,
    ).toBe(true);

    expect(
      resolveProviderModelCapabilities({
        provider: "xai",
        model: "grok-4.5",
      }).acceptsReasoningEffort,
    ).toBe(true);

    expect(
      resolveProviderModelCapabilities({
        provider: "grok",
        model: "grok-4.20-multi-agent",
      }).acceptsReasoningEffort,
    ).toBe(true);
  });

  it.each(DEPTH_EFFORTS)(
    "wire builder: attaches Grok 4.5 reasoning effort %s",
    (reasoningEffort) => {
      const params = buildXaiResponsesRequest({
        model: "grok-4.5",
        messages: USER_TURN,
        options: { reasoningEffort },
      });
      expect(params.reasoning).toEqual({ effort: reasoningEffort });
    },
  );

  it("wire builder: attaches reasoning for grok-4.3", () => {
    const params = buildXaiResponsesRequest({
      model: "grok-4.3",
      messages: USER_TURN,
      options: { reasoningEffort: "high" },
    });
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it("wire builder: attaches reasoning for grok-4.20-multi-agent", () => {
    const params = buildXaiResponsesRequest({
      model: "grok-4.20-multi-agent",
      messages: USER_TURN,
      options: { reasoningEffort: "high" },
    });
    expect(params.reasoning).toEqual({ effort: "high" });
  });

  it.each(DEPTH_EFFORTS)(
    "adapter: attaches Grok 4.5 reasoning effort %s",
    (reasoningEffort) => {
      const provider = new GrokProvider({
        apiKey: "test-key",
        model: "grok-4.5",
        reasoningEffort,
      });

      const built = (provider as unknown as BuildParamsAccess).buildParams(
        USER_TURN,
        { reasoningEffort },
      );

      expect(built.params.reasoning).toEqual({ effort: reasoningEffort });
      expect(built.params.model).toBe("grok-4.5");
    },
  );

  it("adapter: strips reasoning_effort for an unsupported model", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-build-0.1",
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
    expect(built.params.model).toBe("grok-build-0.1");
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
