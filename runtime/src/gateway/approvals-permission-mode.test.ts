import { describe, it, expect } from "vitest";
import { ApprovalEngine, type SessionPermissionMode } from "./approvals.js";
import type { EffectApprovalReasonCode } from "./safety-tiering.js";

// Full universe of effect reason codes — iterate it so any future code forces a test decision.
const ALL_REASON_CODES: EffectApprovalReasonCode[] = [
  "read_only_effect",
  "workspace_scaffold",
  "workspace_write",
  "workspace_destructive_mutation",
  "protected_workspace_mutation",
  "host_mutation",
  "shell_read_only",
  "shell_mutation",
  "shell_open_world",
  "desktop_read_only",
  "desktop_automation",
  "process_control",
  "server_control",
  "credential_secret_access",
  "irreversible_financial_action",
  "untrusted_mcp_tool",
];

// The ONLY effects bypassPermissions may auto-approve (mirrors BYPASS_APPROVABLE_REASONS).
const BYPASS_APPROVABLE = new Set<string>([
  "read_only_effect",
  "shell_read_only",
  "desktop_read_only",
  "workspace_scaffold",
  "workspace_write",
]);

function engineWith(
  baseMode: string,
  status: "allow" | "require_approval" | "deny",
  reasonCode: string,
): ApprovalEngine {
  const effectPolicy = {
    mode: baseMode,
    evaluate: () => ({
      status,
      source: "effect_policy",
      reasonCode,
      riskLevel: "medium",
      approvalScopeKey: "scope",
      message: "msg",
    }),
  };
  return new ApprovalEngine({ effectPolicy } as never);
}
const decide = (e: ApprovalEngine) => e.simulate("tool", {}, "s");

describe("ApprovalEngine per-session permission mode (P3)", () => {
  describe("bypassPermissions auto-approves ONLY the benign read/edit allowlist (fail-closed)", () => {
    for (const rc of ALL_REASON_CODES) {
      const expectAllow = BYPASS_APPROVABLE.has(rc);
      it(`${rc} -> ${expectAllow ? "auto-approved" : "still prompts"}`, () => {
        const e = engineWith("safe_local_dev", "require_approval", rc);
        e.setSessionPermissionMode("s", "bypassPermissions");
        const d = decide(e);
        if (expectAllow) {
          expect(d.required).not.toBe(true);
          expect(d.denied).not.toBe(true);
        } else {
          expect(d.required).toBe(true);
        }
      });
    }
  });

  describe("a hard deny is never overridden by any mode", () => {
    const modes: SessionPermissionMode[] = ["default", "plan", "acceptEdits", "bypassPermissions"];
    for (const mode of modes) {
      it(`stays denied under ${mode}`, () => {
        const e = engineWith("safe_local_dev", "deny", "untrusted_mcp_tool");
        e.setSessionPermissionMode("s", mode);
        expect(decide(e).denied).toBe(true);
      });
    }
  });

  describe("bypass never relaxes above the hardened floor", () => {
    for (const baseMode of ["unattended_background", "benchmark"]) {
      it(`${baseMode} base: shell_mutation still prompts`, () => {
        const e = engineWith(baseMode, "require_approval", "shell_mutation");
        e.setSessionPermissionMode("s", "bypassPermissions");
        expect(decide(e).required).toBe(true);
      });
    }
  });

  describe("plan mode is read-only", () => {
    it("read-only effect passes", () => {
      const e = engineWith("safe_local_dev", "allow", "read_only_effect");
      e.setSessionPermissionMode("s", "plan");
      expect(decide(e).denied).not.toBe(true);
    });
    it("a mutating effect is blocked even if base-allowed", () => {
      const e = engineWith("safe_local_dev", "allow", "shell_mutation");
      e.setSessionPermissionMode("s", "plan");
      expect(decide(e).denied).toBe(true);
    });
  });

  describe("acceptEdits auto-approves only workspace edits", () => {
    it("workspace_write prompt -> auto-approved", () => {
      const e = engineWith("safe_local_dev", "require_approval", "workspace_write");
      e.setSessionPermissionMode("s", "acceptEdits");
      const d = decide(e);
      expect(d.required).not.toBe(true);
      expect(d.denied).not.toBe(true);
    });
    it("shell_mutation prompt -> still prompts", () => {
      const e = engineWith("safe_local_dev", "require_approval", "shell_mutation");
      e.setSessionPermissionMode("s", "acceptEdits");
      expect(decide(e).required).toBe(true);
    });
  });

  describe("default and reset", () => {
    it("default leaves the base decision unchanged", () => {
      const e = engineWith("safe_local_dev", "require_approval", "shell_mutation");
      expect(decide(e).required).toBe(true);
    });
    it("setting then clearing restores prompting", () => {
      const e = engineWith("safe_local_dev", "require_approval", "shell_mutation");
      e.setSessionPermissionMode("s", "bypassPermissions");
      e.setSessionPermissionMode("s", "default");
      expect(decide(e).required).toBe(true);
    });
  });
});
