import { describe, expect, it, vi } from "vitest";

import {
  WorkflowHandoffSpool,
  WorkflowHandoffSpoolTokenLimitError,
} from "../../src/agents/workflow-handoff-spool.js";
import { estimateUtf8TokenUnits } from "../../src/llm/token-accounting.js";

describe("WorkflowHandoffSpool", () => {
  it("preserves multibyte deltas and counts a split Unicode stream fail-closed", async () => {
    const spool = WorkflowHandoffSpool.create({
      maximumBytes: 1_024,
      maximumTokens: 1_024,
    });
    try {
      spool.reset();
      spool.writeCanonicalDelta("\ud83d");
      spool.writeCanonicalDelta("\ude00");
      spool.writeCanonicalDelta("e");
      spool.writeCanonicalDelta("\u0301");
      spool.writeCanonicalDelta("ﬃ");
      const source = spool.seal();
      const bytes = await collectSource(source);
      const text = "😀e\u0301ﬃ";

      expect(bytes.toString("utf8")).toBe(text);
      expect(source.byteLength).toBe(Buffer.byteLength(text, "utf8"));
      expect(spool.tokenCount).toBeGreaterThanOrEqual(
        estimateUtf8TokenUnits(text, 1),
      );
    } finally {
      await spool.dispose();
    }
  });

  it("aborts before a multibyte delta crosses the C1 token ceiling", async () => {
    const onLimit = vi.fn();
    const spool = WorkflowHandoffSpool.create({
      maximumBytes: 1_024,
      maximumTokens: 3,
      onLimit,
    });
    try {
      spool.reset();
      expect(() => spool.writeCanonicalDelta("😀")).toThrow(
        WorkflowHandoffSpoolTokenLimitError,
      );
      expect(onLimit).toHaveBeenCalledOnce();
      expect(spool.failure).toBeInstanceOf(
        WorkflowHandoffSpoolTokenLimitError,
      );
    } finally {
      await spool.dispose();
    }
  });

  it("discards a prior provider attempt when the stream resets", async () => {
    const spool = WorkflowHandoffSpool.create({
      maximumBytes: 1_024,
      maximumTokens: 1_024,
    });
    try {
      spool.reset();
      spool.writeCanonicalDelta("stale attempt");
      spool.reset();
      spool.writeCanonicalDelta("fresh attempt");

      expect((await collectSource(spool.seal())).toString("utf8")).toBe(
        "fresh attempt",
      );
      expect(spool.tokenCount).toBe(
        estimateUtf8TokenUnits("fresh attempt", 1),
      );
    } finally {
      await spool.dispose();
    }
  });
});

async function collectSource(source: {
  chunks(): AsyncIterable<Uint8Array>;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source.chunks()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
