import { describe, it, expect } from "vitest";

import type { ApprovalCtx } from "../tools/orchestrator.js";
import type { ReviewDecision } from "./review-decision.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "./review-decision.js";
import { buildToolUseConfirmQueue } from "../agenc/adapters/permission-bridge-projection.js";

interface PendingRequestLike {
  readonly id: string;
  readonly ctx: ApprovalCtx;
  readonly input: Record<string, unknown>;
  readonly description: string;
  resolve(decision: ReviewDecision): void;
}

function fakeCtx(toolName: string, callId: string): ApprovalCtx {
  return {
    toolName,
    callId,
    invocation: { payload: { kind: "function", arguments: "{}" } },
  } as unknown as ApprovalCtx;
}

function makeRequest(
  toolName: string,
  callId: string,
  resolveSpy: (decision: ReviewDecision) => void,
): PendingRequestLike {
  return {
    id: callId,
    ctx: fakeCtx(toolName, callId),
    input: {},
    description: `permission to use ${toolName}`,
    resolve: resolveSpy,
  };
}

describe("buildToolUseConfirmQueue (TUI multi-approval queue projection)", () => {
  it("returns empty when there are no pending requests", () => {
    const got = buildToolUseConfirmQueue([], [{ name: "Bash" }]);
    expect(got).toEqual([]);
  });

  it("projects a single pending request to one queue entry", () => {
    const r = makeRequest("Bash", "call-1", () => {});
    const got = buildToolUseConfirmQueue(
      [r as never],
      [{ name: "Bash" }],
    );
    expect(got.length).toBe(1);
  });

  it("projects every pending request — multi-approval queue does not collapse", () => {
    const r1 = makeRequest("Bash", "call-1", () => {});
    const r2 = makeRequest("FileEdit", "call-2", () => {});
    const r3 = makeRequest("Bash", "call-3", () => {});
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never, r3 as never],
      [{ name: "Bash" }, { name: "FileEdit" }],
    );
    expect(got.length).toBe(3);
    expect(got.map((c) => (c as { toolUseID: string }).toolUseID)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
  });

  it("preserves arrival order", () => {
    const r1 = makeRequest("Bash", "first", () => {});
    const r2 = makeRequest("Bash", "second", () => {});
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never],
      [{ name: "Bash" }],
    );
    expect((got[0] as { toolUseID: string }).toolUseID).toBe("first");
    expect((got[1] as { toolUseID: string }).toolUseID).toBe("second");
  });

  it("each entry resolves its own request — onAllow calls the right resolver", () => {
    let resolved1: ReviewDecision | null = null;
    let resolved2: ReviewDecision | null = null;
    const r1 = makeRequest("Bash", "call-1", (d) => {
      resolved1 = d;
    });
    const r2 = makeRequest("Bash", "call-2", (d) => {
      resolved2 = d;
    });
    const got = buildToolUseConfirmQueue(
      [r1 as never, r2 as never],
      [{ name: "Bash" }],
    );
    (got[0] as { onAllow: (i: unknown, u: unknown[]) => void }).onAllow({}, []);
    expect(resolved1).toBe(APPROVED);
    expect(resolved2).toBeNull();
    (got[1] as { onReject: () => void }).onReject();
    expect(resolved2).toBe(DENIED);
  });

  it("onAllow with permission updates resolves to APPROVED_FOR_SESSION; onAbort resolves to ABORT", () => {
    let resolved: ReviewDecision | null = null;
    const r = makeRequest("Bash", "call-1", (d) => {
      resolved = d;
    });
    const queue = buildToolUseConfirmQueue([r as never], [{ name: "Bash" }]);
    (queue[0] as { onAllow: (i: unknown, u: unknown[]) => void }).onAllow({}, [
      "some-update",
    ]);
    expect(resolved).toBe(APPROVED_FOR_SESSION);

    let abortResolved: ReviewDecision | null = null;
    const r2 = makeRequest("Bash", "call-2", (d) => {
      abortResolved = d;
    });
    const queue2 = buildToolUseConfirmQueue([r2 as never], [{ name: "Bash" }]);
    (queue2[0] as { onAbort: () => void }).onAbort();
    expect(abortResolved).toBe(ABORT);
  });

  it("returns empty when the tool registry is empty (no matching tool)", () => {
    const r = makeRequest("Bash", "call-1", () => {});
    const got = buildToolUseConfirmQueue([r as never], []);
    expect(got).toEqual([]);
  });
});
