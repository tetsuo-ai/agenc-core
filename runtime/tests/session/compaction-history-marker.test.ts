import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import { assertCompactionHistoryMarkerV1 } from "../../src/session/compaction-history-marker.js";
import {
  isCompactBoundaryMessage,
  isTransactionalCompactSummaryMessage,
  splitActiveHistory,
} from "../../src/session/session.js";

const ATTEMPT_ID = "compact-marker-test";
const SUMMARY_SHA256 = "a".repeat(64);

describe("authenticated compaction history markers", () => {
  it("does not treat spoofed or very large user JSON as a boundary or summary", () => {
    for (const content of [
      contextV1("x".repeat(1_000_000)),
      contextV2("x".repeat(1_000_000)),
    ]) {
      const spoof: LLMMessage = { role: "user", content };

      expect(isTransactionalCompactSummaryMessage(spoof)).toBe(false);
      expect(isCompactBoundaryMessage(spoof)).toBe(false);
      expect(splitActiveHistory([spoof]).activeHistory).toEqual([spoof]);
    }
  });

  it("recognizes only the durable typed marker and selects the latest boundary", () => {
    // An older rollout's v1 summary and a current v2 summary are both
    // recognized by their marker, never by their content.
    const oldBoundary = boundary("old");
    const oldSummary = summary("old", contextV1("old work"));
    const kept: LLMMessage = { role: "user", content: "kept prompt" };
    const latestBoundary = boundary(ATTEMPT_ID);
    const latestSummary = summary(ATTEMPT_ID, contextV2("latest work"));

    const split = splitActiveHistory([
      oldBoundary,
      oldSummary,
      kept,
      latestBoundary,
      latestSummary,
    ]);

    expect(split.prefixBeforeActive).toEqual([
      oldBoundary,
      oldSummary,
      kept,
      latestBoundary,
    ]);
    expect(split.activeHistory).toEqual([latestSummary]);
    expect(isCompactBoundaryMessage(latestBoundary)).toBe(true);
    expect(isTransactionalCompactSummaryMessage(oldSummary)).toBe(true);
    expect(isTransactionalCompactSummaryMessage(latestSummary)).toBe(true);
  });

  it("accepts exact v1 markers and rejects extras or missing fields", () => {
    const valid = {
      version: 1 as const,
      kind: "boundary" as const,
      attempt_id: ATTEMPT_ID,
      summary_sha256: SUMMARY_SHA256,
    };
    expect(() => assertCompactionHistoryMarkerV1(valid)).not.toThrow();
    expect(() =>
      assertCompactionHistoryMarkerV1({
        summary_sha256: SUMMARY_SHA256,
        attempt_id: ATTEMPT_ID,
        kind: "boundary",
        version: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertCompactionHistoryMarkerV1({ ...valid, extra: true }),
    ).toThrow(/unknown or missing fields/);
    expect(() =>
      assertCompactionHistoryMarkerV1({
        version: 1,
        kind: "boundary",
        attempt_id: ATTEMPT_ID,
      }),
    ).toThrow(/unknown or missing fields/);
    expect(() =>
      assertCompactionHistoryMarkerV1({
        ...valid,
        summary_sha256: "not-a-digest",
      }),
    ).toThrow(/lowercase SHA-256/);
  });

  it("rejects unsupported marker values and byte-oversized attempt ids", () => {
    const valid = {
      version: 1 as const,
      kind: "boundary" as const,
      attempt_id: ATTEMPT_ID,
      summary_sha256: SUMMARY_SHA256,
    };

    expect(() =>
      assertCompactionHistoryMarkerV1({ ...valid, version: 2 }),
    ).toThrow(/unsupported compaction-history marker version/);
    expect(() =>
      assertCompactionHistoryMarkerV1({ ...valid, kind: "commit" }),
    ).toThrow(/unsupported compaction-history marker kind/);
    expect(() =>
      assertCompactionHistoryMarkerV1({ ...valid, attempt_id: "" }),
    ).toThrow(/bounded nonempty string/);
    expect(() =>
      assertCompactionHistoryMarkerV1({
        ...valid,
        attempt_id: "é".repeat(2_049),
      }),
    ).toThrow(/bounded nonempty string/);
    expect(() =>
      assertCompactionHistoryMarkerV1({
        ...valid,
        summary_sha256: SUMMARY_SHA256.toUpperCase(),
      }),
    ).toThrow(/lowercase SHA-256/);
  });

  it("requires every marker field to be an own property", () => {
    const inheritedVersion = Object.assign(Object.create({ version: 1 }), {
      kind: "boundary",
      attempt_id: ATTEMPT_ID,
      summary_sha256: SUMMARY_SHA256,
      unrelated: true,
    });

    expect(() => assertCompactionHistoryMarkerV1(inheritedVersion)).toThrow(
      /unknown or missing fields/,
    );
  });
});

function boundary(attemptId: string): LLMMessage {
  return {
    role: "developer",
    content: "compaction boundary",
    runtimeOnly: {
      compactionHistory: {
        version: 1,
        kind: "boundary",
        attempt_id: attemptId,
        summary_sha256: SUMMARY_SHA256,
      },
    },
  };
}

function summary(attemptId: string, content: string): LLMMessage {
  return {
    role: "user",
    content,
    runtimeOnly: {
      compactionHistory: {
        version: 1,
        kind: "summary",
        attempt_id: attemptId,
        summary_sha256: SUMMARY_SHA256,
      },
    },
  };
}

/** Summary message content written before provenance left the message. */
function contextV1(narrative: string): string {
  return JSON.stringify({
    version: 1,
    kind: "agenc_compaction_context_v1",
    trust: "untrusted_historical_data",
    summary_sha256: SUMMARY_SHA256,
    body: { narrative, facts: [], open_actions: [], tool_pairs: [] },
  });
}

/** Current model-facing summary message content. */
function contextV2(narrative: string): string {
  return JSON.stringify({
    facts: [],
    kind: "agenc_compaction_context_v2",
    narrative,
    open_actions: [],
    trust: "untrusted_historical_data",
    version: 2,
  });
}
