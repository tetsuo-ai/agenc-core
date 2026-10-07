import { describe, expect, it } from "vitest";

import { isKnownRolloutType } from "../../src/session/rollout-item.js";

const KNOWN_TYPES = [
  "session_meta",
  "session_state",
  "response_item",
  "compacted",
  "turn_context",
  "event_msg",
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
  "unknown",
] as const;

describe("isKnownRolloutType", () => {
  it("recognizes every current reducer type including unknown", () => {
    for (const type of KNOWN_TYPES) {
      expect(isKnownRolloutType(type)).toBe(true);
    }
  });

  it("leaves future types and empty tags for the forward-compat shim", () => {
    expect(isKnownRolloutType("")).toBe(false);
    expect(isKnownRolloutType("session-meta")).toBe(false);
    expect(isKnownRolloutType("future_slot")).toBe(false);
    expect(isKnownRolloutType("Session_meta")).toBe(false);
  });

  it("does not treat on-disk legacy aliases as known types", () => {
    expect(isKnownRolloutType("task_started")).toBe(false);
    expect(isKnownRolloutType("task_complete")).toBe(false);
    expect(isKnownRolloutType("turn_started")).toBe(false);
    expect(isKnownRolloutType("turn_complete")).toBe(false);
  });
});
