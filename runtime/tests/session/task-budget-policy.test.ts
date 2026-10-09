import { describe, expect, it } from "vitest";
import type { ConfigProvenanceEntry, ConfigScope } from "../../src/config/repository.js";
import { selectTaskBudgetPolicy, taskBudgetPolicyAllowsCapability, type TaskBudgetCapability } from "../../src/session/task-budget-policy.js";

const source = (scope: ConfigScope): ConfigProvenanceEntry => ({ scope, label: scope, contributors: [{ scope, label: scope }] });
const bounded: TaskBudgetCapability = { provider: "api", model: "test", supportsMaxOutputTokens: true, usageReporting: "authoritative" };
const unbounded: TaskBudgetCapability = { provider: "subscription", model: "test", supportsMaxOutputTokens: false, usageReporting: "authoritative" };
const input = { rootRunId: "root", tokenLimit: 219000, tokenProvenance: source("default"), capabilities: [unbounded] };

describe("candidate automatic task budget policy", () => {
  it("requires positive builtin provenance to choose a call-bounded observed target", () => {
    expect(selectTaskBudgetPolicy(input)).toMatchObject({ mode: "observed", origin: "builtin", maxCalls: 16,
      callOrigin: "automatic", tokenSemantics: "observed_target" });
    expect(selectTaskBudgetPolicy({ ...input, capabilities: [bounded] })).toMatchObject({ mode: "strict", maxCalls: 0 });
  });
  it.each(["plugin", "user", "project", "local", "flag", "profile", "environment", "cli", "managed"] as const)(
    "keeps an explicit same-value219000 setting strict from %s", scope => {
      expect(selectTaskBudgetPolicy({ ...input, tokenProvenance: source(scope) }))
        .toMatchObject({ origin: "explicit", mode: "strict", maxCalls: 0, tokenSemantics: "reservation_ceiling" });
    });
  it.each([undefined, source("default")])("does not reclassify an existing root from current config", tokenProvenance => {
    expect(selectTaskBudgetPolicy({ ...input, existingRoot: true, tokenProvenance }))
      .toMatchObject({ origin: "legacy", mode: "strict", maxCalls: 0 });
  });
  it("keeps custom-loader or missing provenance strict", () => {
    expect(selectTaskBudgetPolicy({ ...input, tokenProvenance: undefined })).toMatchObject({ origin: "legacy", mode: "strict" });
    expect(selectTaskBudgetPolicy({ ...input, capabilities: [] })).toMatchObject({ origin: "builtin", mode: "strict" });
  });
  it("lets token zero disable the automatic fallback without disabling a configured call cap", () => {
    expect(selectTaskBudgetPolicy({ ...input, tokenLimit: 0 })).toMatchObject({ mode: "disabled", maxCalls: 0 });
    expect(selectTaskBudgetPolicy({ ...input, tokenLimit: 0, maxCalls: 3 })).toMatchObject({ mode: "disabled", maxCalls: 3 });
  });
  it.each([0, 3, 40])("preserves explicit call override %s", maxCalls => {
    expect(selectTaskBudgetPolicy({ ...input, maxCalls })).toMatchObject({ mode: "observed", maxCalls, callOrigin: "configured" });
    expect(selectTaskBudgetPolicy({ ...input, maxCalls, tokenProvenance: source("cli") })).toMatchObject({ mode: "strict", maxCalls });
  });
  it.each(["unavailable"] as const)("labels %s reporting as an observed target", usageReporting => {
    expect(selectTaskBudgetPolicy({ ...input, capabilities: [{ ...bounded, usageReporting }] }))
      .toMatchObject({ mode: "observed", tokenSemantics: "observed_target" });
  });
  it("freezes a mixed capability set and refuses unregistered switches or capability changes", () => {
    const caps = [{ ...unbounded }, { ...bounded }];
    const policy = selectTaskBudgetPolicy({ ...input, capabilities: caps });
    expect(taskBudgetPolicyAllowsCapability(policy, bounded)).toBe(true);
    expect(taskBudgetPolicyAllowsCapability(policy, unbounded)).toBe(true);
    expect(taskBudgetPolicyAllowsCapability(policy, { ...bounded, supportsMaxOutputTokens: false })).toBe(false);
    expect(taskBudgetPolicyAllowsCapability(policy, { ...unbounded, supportsMaxOutputTokens: true })).toBe(false);
    expect(taskBudgetPolicyAllowsCapability(policy, { ...unbounded, model: "other" })).toBe(false);
    caps[0]!.provider = "changed";
    expect(taskBudgetPolicyAllowsCapability(policy, unbounded)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.capabilities)).toBe(true);
    expect(policy.capabilities.every(Object.isFrozen)).toBe(true);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s", value => {
    expect(() => selectTaskBudgetPolicy({ ...input, tokenLimit: value })).toThrow();
    expect(() => selectTaskBudgetPolicy({ ...input, maxCalls: value })).toThrow();
  });
  it("rejects duplicate or incomplete capability identities", () => {
    expect(() => selectTaskBudgetPolicy({ ...input, capabilities: [bounded, bounded] })).toThrow("Duplicate");
    expect(() => selectTaskBudgetPolicy({ ...input, capabilities: [{ ...bounded, model: "" }] })).toThrow("concrete");
    expect(() => selectTaskBudgetPolicy({ ...input, rootRunId: " " })).toThrow("root run");
  });
});
