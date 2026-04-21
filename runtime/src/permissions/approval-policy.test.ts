import { describe, expect, test } from "vitest";
import {
  DEFAULT_APPROVAL_POLICY,
  defaultExecApprovalRequirement,
  resolveApprovalPolicy,
  type GranularApprovalConfig,
} from "./approval-policy.js";

describe("resolveApprovalPolicy — CLI > project-trust > config > default", () => {
  test("no inputs → DEFAULT_APPROVAL_POLICY (on_request)", () => {
    expect(resolveApprovalPolicy({})).toBe(DEFAULT_APPROVAL_POLICY);
    expect(DEFAULT_APPROVAL_POLICY).toBe("on_request");
  });

  test("cliOverride beats every other signal", () => {
    expect(
      resolveApprovalPolicy({
        cliOverride: "never",
        configPolicy: "untrusted",
        projectTrust: "untrusted",
      }),
    ).toBe("never");
  });

  test("projectTrust=trusted → on_request (overrides configPolicy)", () => {
    expect(
      resolveApprovalPolicy({
        configPolicy: "untrusted",
        projectTrust: "trusted",
      }),
    ).toBe("on_request");
  });

  test("projectTrust=untrusted → untrusted (overrides configPolicy)", () => {
    expect(
      resolveApprovalPolicy({
        configPolicy: "never",
        projectTrust: "untrusted",
      }),
    ).toBe("untrusted");
  });

  test("no cli / no trust → configPolicy when provided", () => {
    expect(resolveApprovalPolicy({ configPolicy: "granular" })).toBe("granular");
  });
});

describe("defaultExecApprovalRequirement — full decision table", () => {
  test("never + full_access → skip", () => {
    const r = defaultExecApprovalRequirement("never", "full_access");
    expect(r.kind).toBe("skip");
  });

  test("never + restricted → skip", () => {
    const r = defaultExecApprovalRequirement("never", "restricted");
    expect(r.kind).toBe("skip");
  });

  test("on_failure + full_access → skip", () => {
    const r = defaultExecApprovalRequirement("on_failure", "full_access");
    expect(r.kind).toBe("skip");
  });

  test("on_failure + restricted → skip", () => {
    const r = defaultExecApprovalRequirement("on_failure", "restricted");
    expect(r.kind).toBe("skip");
  });

  test("on_request + full_access → skip", () => {
    const r = defaultExecApprovalRequirement("on_request", "full_access");
    expect(r.kind).toBe("skip");
  });

  test("on_request + restricted → needs_approval", () => {
    const r = defaultExecApprovalRequirement("on_request", "restricted");
    expect(r.kind).toBe("needs_approval");
  });

  test("granular + full_access → skip (no granular config needed)", () => {
    const r = defaultExecApprovalRequirement("granular", "full_access");
    expect(r.kind).toBe("skip");
  });

  test("granular + restricted + sandbox_approval=true → needs_approval", () => {
    const g: GranularApprovalConfig = {
      sandbox_approval: true,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: false,
    };
    const r = defaultExecApprovalRequirement("granular", "restricted", g);
    expect(r.kind).toBe("needs_approval");
  });

  test("granular + restricted + sandbox_approval=false → forbidden (exact codex message)", () => {
    const g: GranularApprovalConfig = {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: false,
    };
    const r = defaultExecApprovalRequirement("granular", "restricted", g);
    expect(r.kind).toBe("forbidden");
    if (r.kind === "forbidden") {
      expect(r.reason).toBe(
        "approval policy disallowed sandbox approval prompt",
      );
    }
  });

  test("untrusted + full_access → needs_approval", () => {
    const r = defaultExecApprovalRequirement("untrusted", "full_access");
    expect(r.kind).toBe("needs_approval");
  });

  test("untrusted + restricted → needs_approval", () => {
    const r = defaultExecApprovalRequirement("untrusted", "restricted");
    expect(r.kind).toBe("needs_approval");
  });
});

describe("GranularApprovalConfig — 5 booleans", () => {
  test("shape carries all five boolean gates independently", () => {
    const g: GranularApprovalConfig = {
      sandbox_approval: true,
      rules: false,
      skill_approval: true,
      request_permissions: false,
      mcp_elicitations: true,
    };
    expect(g.sandbox_approval).toBe(true);
    expect(g.rules).toBe(false);
    expect(g.skill_approval).toBe(true);
    expect(g.request_permissions).toBe(false);
    expect(g.mcp_elicitations).toBe(true);
  });
});
