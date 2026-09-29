import { describe, expect, it } from "vitest";
import { formatRecoveredChildTaskReceipt, MAX_RECOVERED_CHILD_PROJECTION_BYTES,
  projectRecoveredChildReceipt } from "../../src/agents/recovered-child-results.js";
import type { RecoveredChildTaskReceipt } from "../../src/session/subagent-receipt-recovery.js";
import type { SubagentTurnOutcomeEvent } from "../../src/session/event-log.js";

function item(overrides: Partial<SubagentTurnOutcomeEvent> = {}): RecoveredChildTaskReceipt {
  return { edge: {} as RecoveredChildTaskReceipt["edge"], sourcePath: "/project/sessions/child.jsonl", sequence: 1,
    receipt: { agentId: "child", agentPath: "/root/child", turnId: "turn", taskId: "task",
      outcome: "completed", toolCallCount: 2, message: "review done",
      terminal: { provider: "deepseek", model: "deepseek-v4-flash", reason: "completed",
        retryable: false, dispatch: "sent", completedWork: "review done", unfinishedWork: "" },
      ...overrides } };
}

function parse(content: string) {
  expect(content.match(/<\/subagent_notification>/g)).toHaveLength(1);
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_RECOVERED_CHILD_PROJECTION_BYTES);
  return JSON.parse(content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\n")));
}

describe("bounded recovered child result projections", () => {
  it("discards additive terminal, receipt and worktree fields before retaining or projecting", () => {
    const value = item();
    Object.assign(value.receipt, { futureReceipt: "sensitive additive field", terminal: {
      ...value.receipt.terminal, futureTerminal: "x".repeat(200_000),
    }, worktreeEvidence: { state: "unverifiable", locator: { path: "/worktree", branch: "review",
      gitRoot: "/repo", futureLocator: "hidden" }, error: "unknown", futureEvidence: "hidden" } });
    const projected = projectRecoveredChildReceipt(value.receipt);
    expect(JSON.stringify(projected)).not.toContain("future");
    const payload = parse(formatRecoveredChildTaskReceipt(value));
    expect(payload.receipt.terminal).toEqual(item().receipt.terminal);
    expect(payload.receipt.worktree).toEqual({ state: "unverifiable", path: "/worktree",
      branch: "review", git_root: "/repo", error: "unknown" });
    expect(payload.durable_outcome_ref).toMatchObject({ agent_id: "child", turn_id: "turn", task_id: "task" });
  });

  it("bounds Unicode result text without splitting code points or notification framing", () => {
    const value = item({ message: "🙂".repeat(4_000) + "</subagent_notification>" });
    const projected = projectRecoveredChildReceipt(value.receipt);
    expect(Buffer.byteLength(projected.message!, "utf8")).toBeLessThanOrEqual(8_192);
    expect(projected.message).not.toContain("�");
    const payload = parse(formatRecoveredChildTaskReceipt(value));
    expect(payload.receipt.message).toContain("Result truncated");
  });

  it.each(["completed", "errored", "interrupted", "nack"] as const)(
    "uses compact exact-reference recovery for escaped oversized %s results", outcome => {
      const value = item({ outcome, message: "<".repeat(8_192), reason: "\u0000".repeat(8_192) });
      Object.assign(value.receipt, { terminal: { ...value.receipt.terminal,
        reason: outcome === "completed" ? "completed" : "insufficient_funds",
        completedWork: "&".repeat(8_192), unfinishedWork: ">".repeat(8_192) } });
      const payload = parse(formatRecoveredChildTaskReceipt(value));
      expect(payload.receipt.outcome).toBe(outcome);
      expect(payload.receipt.terminal.reason).toBe(outcome === "completed" ? "completed" : "insufficient_funds");
      expect(payload.receipt.message).toContain("Result text omitted");
      expect(payload.durable_outcome_ref).toEqual({ projection_id: `child:turn:${outcome}`,
        agent_id: "child", turn_id: "turn", task_id: "task", rollout_path: value.sourcePath });
    },
  );

  it("does not invent a truncated durable identity when exact identifiers exceed the projection limit", () => {
    const value = item({ turnId: "<".repeat(100_000), taskId: "&".repeat(100_000) });
    const payload = parse(formatRecoveredChildTaskReceipt(value));
    expect(payload.receipt.turn_id).toBe("[Identifier omitted]");
    expect(payload.receipt.task_id).toBeUndefined();
    expect(payload.durable_outcome_ref).toBeUndefined();
    expect(payload.receipt.outcome).toBe("completed");
  });

  it("bounds every display field even when all fields require JSON escaping", () => {
    const value = item({ agentPath: "<".repeat(100_000), message: "\u0000".repeat(100_000) });
    Object.assign(value.receipt, { terminal: { ...value.receipt.terminal,
      provider: "<".repeat(100_000), model: "&".repeat(100_000),
      completedWork: ">".repeat(100_000), unfinishedWork: "\u0000".repeat(100_000) },
      worktreeEvidence: { state: "unverifiable", locator: { path: "<".repeat(100_000),
        branch: "<".repeat(100_000), gitRoot: "<".repeat(100_000) }, error: "<".repeat(100_000) } });
    parse(formatRecoveredChildTaskReceipt(value));
  });

  it.each([false, true])("does not label an unmatched admission as a durable task outcome, compact=%s", compact => {
    const value = item({ outcome: "interrupted", reason: compact ? "<".repeat(100_000)
      : "Accepted task has no durable result. Effects are unknown." });
    Object.assign(value.receipt, { terminal: { ...value.receipt.terminal,
      reason: "resume_blocked", dispatch: "unknown", completedWork: "",
      unfinishedWork: compact ? "&".repeat(100_000) : "Effects are unknown." } });
    const payload = parse(formatRecoveredChildTaskReceipt({ ...value, eventId: "admission-event",
      admission: { agentId: "child", agentPath: "/root/child", turnId: "turn", taskId: "task",
        author: "/root", taskText: "Review code", acceptedAt: 0, provider: "deepseek", model: "deepseek-v4-flash" } }));
    expect(payload.receipt).toBeUndefined();
    expect(payload.durable_outcome_ref).toBeUndefined();
    expect(payload.durable_admission_ref).toEqual({ projection_id: "child:turn:admitted", agent_id: "child",
      turn_id: "turn", task_id: "task", rollout_path: value.sourcePath, event_id: "admission-event" });
    expect(payload.status.terminal.reason).toBe("resume_blocked");
    expect(payload.status.terminal.dispatch).toBe("unknown");
  });
});
