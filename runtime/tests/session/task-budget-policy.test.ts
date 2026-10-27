import { describe, expect, it } from "vitest";
import type { ConfigProvenanceEntry, ConfigScope } from "../../src/config/repository.js";
import { restoreTaskBudgetPolicy, serializeTaskBudgetPolicy, selectTaskBudgetPolicy, taskBudgetPolicyAllowsCapability, type TaskBudgetCapability } from "../../src/session/task-budget-policy.js";

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

describe("durable task policy record codec", () => {
  it.each([undefined, 0, 3])("retains original policy and call override%s without reselecting current defaults", maxCalls => {
    const original = selectTaskBudgetPolicy({ ...input, maxCalls });
    const stored = serializeTaskBudgetPolicy(original);
    const restored = restoreTaskBudgetPolicy(stored, "root");
    expect(restored).toEqual(original);
    expect(serializeTaskBudgetPolicy(restored)).toBe(stored);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(restored.capabilities.every(Object.isFrozen)).toBe(true);
  });
  it.each([source("cli"), undefined])("keeps explicit and unproven limits strict on restore", tokenProvenance => {
    const original = selectTaskBudgetPolicy({ ...input, tokenProvenance });
    expect(restoreTaskBudgetPolicy(serializeTaskBudgetPolicy(original), "root").mode).toBe("strict");
  });
  it("keeps the saved automatic allowance instead of substituting a newer numeric default", () => {
    const original = selectTaskBudgetPolicy(input);
    const historicalRecord = JSON.stringify({ ...original, maxCalls: 12 });
    expect(restoreTaskBudgetPolicy(historicalRecord, "root").maxCalls).toBe(12);
  });
  it("does not copy opaque execution handles or unrelated provider fields into a policy", () => {
    const capability = { ...unbounded, providerExecutionHandle: { privateTransport: "not-policy-data" } };
    const policy = selectTaskBudgetPolicy({ ...input, capabilities: [capability] });
    expect(serializeTaskBudgetPolicy(policy)).not.toContain("privateTransport");
    expect(policy.capabilities).toEqual([unbounded]);
  });
  it("rejects a record attached to another root or an unsupported version", () => {
    const policy = selectTaskBudgetPolicy(input);
    expect(() => restoreTaskBudgetPolicy(serializeTaskBudgetPolicy(policy), "other-root")).toThrow();
    expect(() => restoreTaskBudgetPolicy(JSON.stringify({ ...policy, version: 2 }), "root")).toThrow();
  });
  it.each([
    { origin: "explicit" }, { tokenLimit: 0 }, { tokenLimit: -1 }, { tokenLimit: "219000" },
    { maxCalls: 0 }, { callOrigin: "off" }, { tokenSemantics: "reservation_ceiling" }, { capabilities: [] },
    { capabilities: [bounded] }, { capabilities: [unbounded, unbounded] }, { extra: true },
    { origin: ["builtin"] }, { mode: ["observed"] }, { callOrigin: ["configured"] },
  ])("rejects inconsistent stored fields %j", patch => {
    expect(() => restoreTaskBudgetPolicy(JSON.stringify({ ...selectTaskBudgetPolicy(input), ...patch }), "root")).toThrow();
  });
  it("retains a configured call guard when the token policy is disabled", () => {
    const original = selectTaskBudgetPolicy({ ...input, tokenLimit: 0, maxCalls: 4 });
    expect(restoreTaskBudgetPolicy(serializeTaskBudgetPolicy(original), "root"))
      .toMatchObject({ mode: "disabled", tokenLimit: 0, maxCalls: 4, callOrigin: "configured" });
  });
});
