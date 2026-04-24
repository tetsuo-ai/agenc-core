import { describe, expect, test } from "vitest";

import type { TranscriptSourceEvent } from "./state/events-to-messages.js";
import { deriveActiveToolCount, deriveBannerPhase } from "./status-derivation.js";

describe("status derivation", () => {
  test("ignores provider-switch breadcrumbs in the banner phase", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-1" } },
      { type: "agent_message", payload: { message: "hi" } },
      {
        type: "warning",
        payload: {
          cause: "provider_switched",
          message:
            "provider grok -> grok; model grok-4-fast -> grok-4.20-0309-non-reasoning; previous_response_id reset",
        },
      },
    ];

    expect(deriveBannerPhase(events)).toBe("assistant");
  });

  test("ignores silent system.searchTools lifecycle in the banner phase", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-1" } },
      { type: "agent_message", payload: { message: "hi" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "search-tools-1",
          toolName: "system.searchTools",
          args: '{"query":"memory"}',
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "search-tools-1",
          result:
            '{"totalCatalogSize":39,"loaded":[],"missingSelections":[],"results":[]}',
          isError: false,
        },
      },
    ];

    expect(deriveBannerPhase(events)).toBe("assistant");
    expect(deriveActiveToolCount(events)).toBe(0);
  });

  test("keeps real tool lifecycle visible in the banner phase", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-1" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "read-1",
          toolName: "system.readFile",
          args: '{"path":"README.md"}',
        },
      },
    ];

    expect(deriveBannerPhase(events)).toBe("tool");
    expect(deriveActiveToolCount(events)).toBe(1);
  });
});
