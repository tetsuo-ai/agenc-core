import { describe, expect, it, vi } from "vitest";

import { buildDefaultRegistry } from "../../../src/commands/registry.js";
import {
  extendCompactionRetentionForOperator,
  rollbackCompactionForOperator,
} from "../../../src/services/compact/operator.js";

function operatorStore() {
  return {
    rollbackCompaction: vi.fn(() => ({
      attempt_id: "attempt-1",
      rollback_mode: "same_session" as const,
      target_session_id: "session-1",
      source_history: [{ role: "user" as const, content: "source" }],
    }) as never),
    extendCompactionRollbackRetention: vi.fn(),
    recordProjectionFailure: vi.fn(),
  };
}

describe("compaction operator surface", () => {
  it("durably authorizes rollback before exposing its projection", () => {
    const store = operatorStore();
    expect(rollbackCompactionForOperator({
      store,
      attemptId: " attempt-1 ",
      nowMs: 100,
    })).toEqual({
      attemptId: "attempt-1",
      mode: "same_session",
      targetSessionId: "session-1",
      sourceHistory: [{ role: "user", content: "source" }],
    });
    expect(store.rollbackCompaction).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      nowMs: 100,
    });
  });

  it("validates reviewed branch IDs before calling storage", () => {
    const store = operatorStore();
    expect(() => rollbackCompactionForOperator({
      store,
      attemptId: "attempt-1",
      nowMs: 100,
      reviewedBranchTargetSessionId: "../escape",
    })).toThrow(/path-safe/u);
    expect(store.rollbackCompaction).not.toHaveBeenCalled();
  });

  it("accepts only future absolute retention deadlines", () => {
    const store = operatorStore();
    extendCompactionRetentionForOperator({
      store,
      attemptId: "attempt-1",
      nowMs: 100,
      extendedUntilMs: 101,
    });
    expect(store.extendCompactionRollbackRetention).toHaveBeenCalledWith(
      "attempt-1",
      101,
    );
    expect(() => extendCompactionRetentionForOperator({
      store,
      attemptId: "attempt-1",
      nowMs: 100,
      extendedUntilMs: 100,
    })).toThrow(/future timestamp/u);
  });

  it("registers unambiguous runtime and daemon command forms", async () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });
    const rollbackCompaction = vi.fn(async () => ({
      ok: true,
      sessionId: "session-1",
      attemptId: "attempt-1",
      mode: "reviewed_branch" as const,
      targetSessionId: "reviewed-1",
      displayText: "restored reviewed branch",
    }));
    const extendCompactionRollbackRetention = vi.fn(async () => ({
      ok: true,
      sessionId: "session-1",
      attemptId: "attempt-1",
      extendedUntilMs: Date.parse("2030-01-01T00:00:00.000Z"),
      displayText: "retention extended",
    }));
    const session = {
      rollbackCompaction,
      extendCompactionRollbackRetention,
    };
    const context = {
      session,
      cwd: "/tmp",
      home: "/tmp",
    };

    await expect(registry.find("compact-rollback")?.execute({
      ...context,
      argsRaw: "attempt-1 --branch reviewed-1",
    } as never)).resolves.toEqual({ kind: "text", text: "restored reviewed branch" });
    await expect(registry.find("compact-retain")?.execute({
      ...context,
      argsRaw: "attempt-1 --until 2030-01-01T00:00:00.000Z",
    } as never)).resolves.toEqual({ kind: "text", text: "retention extended" });

    expect(rollbackCompaction).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      reviewedBranchTargetSessionId: "reviewed-1",
    });
    expect(extendCompactionRollbackRetention).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      extendedUntilMs: Date.parse("2030-01-01T00:00:00.000Z"),
    });
  });
});
