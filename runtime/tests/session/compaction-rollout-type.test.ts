import { describe, expect, test } from "vitest";

import { isCompactionRolloutType } from "../../src/session/compaction-event-reader.js";

const COMPACTION_ROLLOUT_TYPES = [
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
] as const;

describe("isCompactionRolloutType", () => {
  test("recognizes the frozen transactional compaction event set", () => {
    for (const type of COMPACTION_ROLLOUT_TYPES) {
      expect(isCompactionRolloutType(type)).toBe(true);
    }
  });

  test("rejects aliases, casing, and ordinary rollout types", () => {
    for (const type of [
      "",
      "compaction_intent ",
      "Compaction_intent",
      "compaction-intent",
      "compaction_summary",
      "session_meta",
      "turn_started",
      "unknown",
    ]) {
      expect(isCompactionRolloutType(type)).toBe(false);
    }
  });
});
