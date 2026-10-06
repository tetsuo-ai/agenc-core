import { describe, expect, test } from "vitest";

import {
  compactionExhaustedReasonText,
  describeCompactionDecline,
  ladderAppliesToDecline,
  ladderAppliesToReason,
  nextLadderTiers,
  resolveCompactionLadderPolicy,
  strongerTierThan,
  type CompactionDecline,
} from "../../../src/services/compact/ladder.js";

function decline(overrides: Partial<CompactionDecline> = {}): CompactionDecline {
  return {
    wasCompacted: false,
    skippedReason: "compaction candidate cannot meet minimum savings",
    consecutiveFailures: 1,
    skippedFailureReason: "no_shrink",
    ...overrides,
  };
}

describe("resolveCompactionLadderPolicy", () => {
  test("emergency stays on unless the config names never", () => {
    expect(resolveCompactionLadderPolicy(undefined)).toEqual({ emergencyEnabled: true });
    expect(resolveCompactionLadderPolicy({})).toEqual({ emergencyEnabled: true });
    expect(resolveCompactionLadderPolicy({ compaction: {} })).toEqual({ emergencyEnabled: true });
    expect(resolveCompactionLadderPolicy({ compaction: { emergency_mode: "always" } }))
      .toEqual({ emergencyEnabled: true });
    expect(resolveCompactionLadderPolicy({ compaction: { emergency_mode: "never" } }))
      .toEqual({ emergencyEnabled: false });
  });
});

describe("ladderAppliesToReason", () => {
  test("only context-limit and reactive recovery escalate", () => {
    expect(ladderAppliesToReason("context_limit")).toBe(true);
    expect(ladderAppliesToReason("reactive_recovery")).toBe(true);
    expect(ladderAppliesToReason("manual")).toBe(false);
    expect(ladderAppliesToReason("downshift")).toBe(false);
    expect(ladderAppliesToReason("")).toBe(false);
  });
});

describe("ladderAppliesToDecline", () => {
  test("a real lost attempt can escalate", () => {
    expect(ladderAppliesToDecline(decline())).toBe(true);
  });

  test("success, missing facts, and unfixable failures stay off the ladder", () => {
    expect(ladderAppliesToDecline(decline({ wasCompacted: true }))).toBe(false);
    expect(ladderAppliesToDecline(decline({ skippedReason: undefined }))).toBe(false);
    expect(ladderAppliesToDecline(decline({ consecutiveFailures: undefined }))).toBe(false);
    expect(ladderAppliesToDecline(decline({ skippedFailureReason: "pin_failed" }))).toBe(false);
    expect(ladderAppliesToDecline(decline({ skippedFailureReason: "aborted" }))).toBe(false);
  });
});

describe("nextLadderTiers", () => {
  const enabled = { emergencyEnabled: true };
  const never = { emergencyEnabled: false };

  test("a shrink miss still has both stronger tiers", () => {
    expect(nextLadderTiers(enabled, decline(), [])).toEqual([
      "aggressive_summary",
      "emergency_local",
    ]);
  });

  test("provider-side failures skip another summarizer pass", () => {
    for (const reason of [
      "wall_time_exceeded",
      "provider_timeout",
      "provider_unavailable",
      "provider_error",
      "provider_rate_limited",
    ] as const) {
      expect(nextLadderTiers(enabled, decline({ skippedFailureReason: reason }), []), reason)
        .toEqual(["emergency_local"]);
    }
  });

  test("already-attempted and disabled tiers drop out", () => {
    expect(nextLadderTiers(enabled, decline(), ["aggressive_summary"]))
      .toEqual(["emergency_local"]);
    expect(nextLadderTiers(never, decline(), [])).toEqual(["aggressive_summary"]);
    expect(nextLadderTiers(never, decline(), ["aggressive_summary"])).toEqual([]);
    expect(nextLadderTiers(enabled, decline(), ["aggressive_summary", "emergency_local"]))
      .toEqual([]);
    expect(nextLadderTiers(
      never,
      decline({ skippedFailureReason: "provider_timeout" }),
      [],
    )).toEqual([]);
  });
});

describe("strongerTierThan", () => {
  const enabled = { emergencyEnabled: true };
  const never = { emergencyEnabled: false };

  test("walks the remaining stronger tiers", () => {
    expect(strongerTierThan("standard", enabled, [])).toBe("aggressive_summary");
    expect(strongerTierThan("aggressive_summary", enabled, [])).toBe("emergency_local");
    expect(strongerTierThan("emergency_local", enabled, [])).toBeUndefined();
    expect(strongerTierThan("standard", enabled, ["aggressive_summary"])).toBe("emergency_local");
    expect(strongerTierThan("standard", never, [])).toBe("aggressive_summary");
    expect(strongerTierThan("aggressive_summary", never, [])).toBeUndefined();
  });
});

describe("describeCompactionDecline", () => {
  test("names the most specific known fact", () => {
    expect(describeCompactionDecline(decline())).toBe("no_shrink");
    expect(describeCompactionDecline(decline({
      skippedFailureReason: undefined,
      skippedCode: "no_shrink",
    }))).toBe("no_shrink");
    expect(describeCompactionDecline(decline({
      skippedFailureReason: undefined,
      skippedCode: undefined,
      advisoryFailure: "summary_rejected",
    }))).toBe("summary_rejected");
    expect(describeCompactionDecline(decline({
      skippedFailureReason: undefined,
      skippedCode: undefined,
      skippedReason: "x".repeat(200),
    }))).toBe("x".repeat(120));
    expect(describeCompactionDecline({ wasCompacted: false })).toBe("declined");
  });
});

describe("compactionExhaustedReasonText", () => {
  test("interactive turns hint at /compact; unattended turns do not", () => {
    const exhausted = {
      tiersAttempted: ["aggressive_summary", "emergency_local"] as const,
      lastSamplePromptTokens: 3100,
      limit: 2048,
    };
    expect(compactionExhaustedReasonText({ ...exhausted, interactive: false }))
      .toBe("compact_ladder_exhausted: tiers=[aggressive_summary,emergency_local]; lastSamplePromptTokens=3100 limit=2048");
    expect(compactionExhaustedReasonText({ ...exhausted, interactive: true }))
      .toBe("compact_ladder_exhausted: tiers=[aggressive_summary,emergency_local]; lastSamplePromptTokens=3100 limit=2048; run /compact to retry manually");
  });

  test("a ladder that never started names the skip, not an empty tier list", () => {
    const skipped = {
      tiersAttempted: [] as const,
      lastSamplePromptTokens: 4000,
      limit: 2048,
    };
    expect(compactionExhaustedReasonText({ ...skipped, interactive: false }))
      .toBe("mid_turn_compact_skipped: lastSamplePromptTokens=4000 limit=2048");
    expect(compactionExhaustedReasonText({ ...skipped, interactive: true }))
      .toBe("mid_turn_compact_skipped: lastSamplePromptTokens=4000 limit=2048; run /compact to retry manually");
  });
});
