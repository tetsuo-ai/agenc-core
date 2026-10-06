import { describe, expect, it } from "vitest";
import { buildDaemonApprovalCtx, daemonFileWritePreview } from "../../src/tui/daemon-approval-context.js";

describe("daemon approval context", () => {
  it("accepts bounded write previews and drops malformed or oversized ones", () => {
    const exactLimit = "x".repeat(256 * 1024);
    expect(daemonFileWritePreview({ kind: "missing" })).toEqual({ kind: "missing" });
    expect(daemonFileWritePreview({ kind: "existing", content: "old" })).toEqual({
      kind: "existing",
      content: "old",
    });
    expect(daemonFileWritePreview({ kind: "existing", content: exactLimit })).toEqual({
      kind: "existing",
      content: exactLimit,
    });
    expect(daemonFileWritePreview({ kind: "existing", content: `${exactLimit}!` })).toBeUndefined();
    expect(daemonFileWritePreview({ kind: "unavailable", reason: "r".repeat(250) })).toEqual({
      kind: "unavailable",
      reason: "r".repeat(200),
    });
    expect(daemonFileWritePreview(null)).toBeUndefined();
    expect(daemonFileWritePreview({ kind: "existing" })).toBeUndefined();
    expect(daemonFileWritePreview({ kind: "unavailable", reason: 12 })).toBeUndefined();
    expect(daemonFileWritePreview({ kind: "other", content: "x" })).toBeUndefined();
  });

  it("builds an approval context with validated payload fields and safe fallbacks", () => {
    const signal = new AbortController().signal;
    const ctx = buildDaemonApprovalCtx(
      { id: "session" },
      {
        callId: "call-7",
        turnId: "turn-3",
        input: { command: "node --test" },
        reason: "retry after deny",
        planContent: "# plan",
        planFilePath: "/tmp/plan.md",
        fileWritePreview: { kind: "existing", content: "old" },
      },
      "Write",
      signal,
    );
    expect(ctx).toMatchObject({
      callId: "call-7",
      toolName: "Write",
      turnId: "turn-3",
      retryReason: "retry after deny",
      planContent: "# plan",
      planFilePath: "/tmp/plan.md",
      fileWritePreview: { kind: "existing", content: "old" },
      signal,
    });
    expect(ctx.invocation).toMatchObject({
      callId: "call-7",
      source: "direct",
      payload: { kind: "function", arguments: "{\"command\":\"node --test\"}" },
    });
    expect(ctx.invocation.tracker.snapshot()).toEqual([]);

    const fallback = buildDaemonApprovalCtx(
      { id: "session" },
      { callId: "call-8", input: "not-an-object", turnId: 9, reason: 1 },
      "exec_command",
      signal,
    );
    expect(fallback.turnId).toBe("call-8");
    expect(fallback.invocation.payload).toEqual({ kind: "function", arguments: "{}" });
    expect(fallback).not.toHaveProperty("retryReason");
    expect(fallback).not.toHaveProperty("fileWritePreview");
  });
});
