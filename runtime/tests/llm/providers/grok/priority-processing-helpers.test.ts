// Helpers behind xAI priority processing: which Grok models get the Fast
// tier, when the wire sends it, how the served tier reads, and the session
// model info on the xAI sign-in route (see priority-processing.test.ts).
import { describe, expect, test } from "vitest";

import type { ModelInfo } from "../../../session/turn-context.js";
import {
  withoutXaiSignInFastTier,
  xaiSendsPriorityProcessing,
  xaiServedSpeed,
  xaiSupportsPriorityProcessing,
} from "./priority-processing.js";

describe("priority-processing helpers", () => {
  test("only the Grok rows with a Fast tier support it", () => {
    for (const model of ["grok-4.7", "grok-4.6"]) {
      expect(xaiSupportsPriorityProcessing(model), model).toBe(true);
    }
    for (const model of [
      "grok-4.5",
      "grok-4.3",
      "grok-build-0.1",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
      "grok-composer-2.5-fast",
      "grok-4-0709",
      "",
      undefined,
    ]) {
      expect(xaiSupportsPriorityProcessing(model), String(model)).toBe(false);
    }
  });

  test("sends only a priority turn on a Fast model outside the sign-in route", () => {
    expect(xaiSendsPriorityProcessing({ model: "grok-4.7", serviceTier: "priority", authMode: undefined })).toBe(true);
    expect(xaiSendsPriorityProcessing({ model: "grok-4.7", serviceTier: "priority", authMode: "api_key" })).toBe(true);
    expect(xaiSendsPriorityProcessing({ model: "grok-4.7", serviceTier: "priority", authMode: "oauth" })).toBe(false);
    expect(xaiSendsPriorityProcessing({ model: "grok-4.7", serviceTier: "flex", authMode: undefined })).toBe(false);
    expect(xaiSendsPriorityProcessing({ model: "grok-4.5", serviceTier: "priority", authMode: undefined })).toBe(false);
  });

  test("reads priority and fast as served fast, anything else as not", () => {
    expect(xaiServedSpeed("priority")).toBe("fast");
    expect(xaiServedSpeed("fast")).toBe("fast");
    expect(xaiServedSpeed("default")).toBeUndefined();
    expect(xaiServedSpeed(undefined)).toBeUndefined();
    expect(xaiServedSpeed(1)).toBeUndefined();
  });

  const fastInfo: ModelInfo = {
    slug: "grok-4.7",
    provider: "grok",
    effectiveContextWindowPercent: 95,
    supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Higher scheduling priority at 2x price" },
    ],
    defaultReasoningSummary: "none",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };

  test("a session bound to the xAI sign-in route does not list the Fast tier", () => {
    const signedIn = withoutXaiSignInFastTier(fastInfo, {
      provider: "grok",
      factoryOptions: { extra: { authMode: "oauth" } },
    });
    expect(signedIn.serviceTiers).toBeUndefined();
    expect(signedIn).toMatchObject({ slug: "grok-4.7", supportedReasoningLevels: fastInfo.supportedReasoningLevels });
  });

  test("API-key Grok sessions and other providers keep their tiers", () => {
    for (const binding of [
      { provider: "grok", factoryOptions: { extra: { authMode: "api_key" } } },
      { provider: "grok", factoryOptions: {} },
      { provider: "openai", factoryOptions: { extra: { authMode: "oauth" } } },
    ]) {
      expect(withoutXaiSignInFastTier(fastInfo, binding), binding.provider).toBe(fastInfo);
    }
  });
});
