import { describe, expect, it } from "vitest";
import type { PendingToolApproval } from "../../src/app-server/protocol/index.js";
import { formatPendingToolApprovals } from "../../src/permissions/pending-approval-display.js";

function request(overrides: Partial<PendingToolApproval> = {}): PendingToolApproval {
  return {
    requestId: "req_1",
    ownerRunId: "run_owner",
    sessionId: "sess_1",
    toolName: "exec_command",
    ...overrides,
  };
}

describe("pending approval display", () => {
  it("returns no text when nothing is waiting", () => {
    expect(formatPendingToolApprovals([])).toBe("");
  });

  it("prints approve and revoke commands only for safe owner and request IDs", () => {
    const text = formatPendingToolApprovals([
      request({
        turnId: "turn-9",
        reason: "needs shell",
        input: { cmd: "node --test" },
        planFilePath: "/tmp/plan.md",
        planContent: "# plan",
        fileWritePreview: { kind: "missing" },
      }),
    ]);
    expect(text).toContain("Pending approvals (1)");
    expect(text).toContain('request "req_1"');
    expect(text).toContain('owner run "run_owner"');
    expect(text).toContain('tool "exec_command"');
    expect(text).toContain('turn "turn-9"');
    expect(text).toContain("input {\"cmd\":\"node --test\"}");
    expect(text).toContain("plan file \"/tmp/plan.md\"");
    expect(text).toContain("file preview {\"kind\":\"missing\"}");
    expect(text).toContain("agenc permissions approve --session run_owner --scope once req_1");
    expect(text).toContain("agenc permissions revoke --session run_owner req_1");
  });

  it("does not emit shell commands for IDs that could break the printed invocation", () => {
    const text = formatPendingToolApprovals([
      request({ requestId: "req; rm -rf /", ownerRunId: "run_owner" }),
      request({ requestId: "req_2", ownerRunId: "-evil" }),
      request({ requestId: "req 3", ownerRunId: "run_owner" }),
      request({ requestId: ".hidden", ownerRunId: "run_owner" }),
    ]);
    expect(text).toContain("Pending approvals (4)");
    expect(text).not.toMatch(/agenc permissions (approve|revoke)/u);
    expect(text).toContain("Use permissions approve/revoke with the displayed owner run and request IDs.");
  });

  it("escapes C1 controls so displayed values stay single-line JSON", () => {
    const text = formatPendingToolApprovals([
      request({ toolName: `exec\u0085command`, requestId: "req_ok", ownerRunId: "run_ok" }),
    ]);
    expect(text).toContain("tool \"exec\\u0085command\"");
    expect(text).not.toContain("exec\u0085command");
    expect(text).toContain("agenc permissions approve --session run_ok --scope once req_ok");
  });
});
