import { describe, expect, test } from "vitest";
import {
  buildDefaultTriggerOrder,
  I10_TRIGGER_ORDER,
  type TriggerActions,
  type TriggerOutcome,
} from "./triggers.js";

const NOOP_ACTIONS: TriggerActions = {
  async on413(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onMedia(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onMaxOutputTokens(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onStopHookBlocking(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onStreamingFallback(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onFallbackError(): Promise<TriggerOutcome> { return { kind: "pass" }; },
};

describe("I-10 recovery trigger priority", () => {
  test("buildDefaultTriggerOrder matches documented I10_TRIGGER_ORDER array", () => {
    const triggers = buildDefaultTriggerOrder(NOOP_ACTIONS);
    expect(triggers.map((t) => t.name)).toEqual([...I10_TRIGGER_ORDER]);
  });

  test("exact I-10 priority list", () => {
    expect([...I10_TRIGGER_ORDER]).toEqual([
      "isWithheld413",
      "isWithheldMedia",
      "isWithheldMaxOutputTokens",
      "stopHookBlocking",
      "streamingFallbackOccured",
      "FallbackTriggeredError",
    ]);
  });
});
