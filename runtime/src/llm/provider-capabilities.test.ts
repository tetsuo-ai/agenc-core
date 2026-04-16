import { describe, expect, it } from "vitest";

import {
  assertXaiReasoningEffortCompatibility,
  resolveLLMStatefulResponsesConfig,
} from "./provider-capabilities.js";
import {
  supportsXaiReasoningEffortParam,
} from "./structured-output.js";
import { LLMProviderError } from "./errors.js";

describe("resolveLLMStatefulResponsesConfig", () => {
  it("defaults store=true when stateful responses are enabled without an explicit store override", () => {
    expect(
      resolveLLMStatefulResponsesConfig({
        enabled: true,
        fallbackToStateless: true,
      }),
    ).toMatchObject({
      enabled: true,
      store: true,
      fallbackToStateless: true,
    });
  });

  it("preserves explicit store=true overrides", () => {
    expect(
      resolveLLMStatefulResponsesConfig({
        enabled: true,
        store: true,
      }),
    ).toMatchObject({
      enabled: true,
      store: true,
    });
  });
});

describe("supportsXaiReasoningEffortParam", () => {
  it.each([
    ["grok-4.20-multi-agent-beta-0309", true],
    ["grok-4.20-multi-agent", true],
    ["grok-4-20-multi-agent", true],
  ])("accepts multi-agent variant %s", (model, expected) => {
    expect(supportsXaiReasoningEffortParam(model)).toBe(expected);
  });

  it.each([
    ["grok-code-fast-1", false],
    ["grok-4-1-fast-non-reasoning", false],
    ["grok-4-1-fast-reasoning", false],
    ["grok-4.20-beta-0309-reasoning", false],
    ["grok-4.20-beta-0309-non-reasoning", false],
    ["grok-4-0709", false],
    ["grok-3", false],
    ["", false],
  ])("rejects non-multi-agent variant %s", (model, expected) => {
    expect(supportsXaiReasoningEffortParam(model)).toBe(expected);
  });

  it("rejects undefined model", () => {
    expect(supportsXaiReasoningEffortParam(undefined)).toBe(false);
  });
});

describe("assertXaiReasoningEffortCompatibility", () => {
  it("is a no-op when reasoningEffort is not requested", () => {
    expect(() =>
      assertXaiReasoningEffortCompatibility({
        providerName: "grok",
        model: "grok-code-fast-1",
        reasoningEffortRequested: false,
      }),
    ).not.toThrow();
  });

  it("is a no-op on multi-agent variants that accept the field", () => {
    expect(() =>
      assertXaiReasoningEffortCompatibility({
        providerName: "grok",
        model: "grok-4.20-multi-agent-beta-0309",
        reasoningEffortRequested: true,
      }),
    ).not.toThrow();
  });

  it.each([
    "grok-code-fast-1",
    "grok-4-1-fast-non-reasoning",
    "grok-4-1-fast-reasoning",
    "grok-4.20-beta-0309-reasoning",
  ])(
    "throws LLMProviderError when reasoning_effort is requested on unsupported model %s",
    (model) => {
      expect(() =>
        assertXaiReasoningEffortCompatibility({
          providerName: "grok",
          model,
          reasoningEffortRequested: true,
        }),
      ).toThrow(LLMProviderError);
      expect(() =>
        assertXaiReasoningEffortCompatibility({
          providerName: "grok",
          model,
          reasoningEffortRequested: true,
        }),
      ).toThrow(/grok-4\.20-multi-agent/);
    },
  );

  it("surfaces the model name in the error message", () => {
    const run = () =>
      assertXaiReasoningEffortCompatibility({
        providerName: "grok",
        model: "grok-code-fast-1",
        reasoningEffortRequested: true,
      });
    expect(run).toThrow(/requested grok-code-fast-1/);
  });
});
