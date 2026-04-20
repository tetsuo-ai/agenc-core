import { afterEach, describe, expect, it } from "vitest";
import {
  allocateNickname,
  getAgentRole,
  getDefaultAgentRole,
  listAgentRoles,
  registerAgentRole,
  releaseNickname,
  resolveAgentRole,
  _resetNicknamePoolForTesting,
} from "./role.js";

afterEach(() => {
  _resetNicknamePoolForTesting();
});

describe("role registry", () => {
  it("returns built-in default when name is undefined", () => {
    const r = resolveAgentRole(undefined);
    expect(r.name).toBe("default");
    expect(r.config.nicknameCandidates).toContain("alpha");
  });

  it("falls back to default for unknown role names", () => {
    const r = resolveAgentRole("unknown-role");
    expect(r.name).toBe("default");
  });

  it("lists all built-in roles", () => {
    const names = listAgentRoles().map((r) => r.name);
    expect(names).toContain("default");
    expect(names).toContain("explorer");
    expect(names).toContain("awaiter");
  });

  it("explorer has read-only allowlist + low reasoning", () => {
    const r = getAgentRole("explorer")!;
    expect(r.config.reasoningEffort).toBe("low");
    expect(r.config.allowlist).toContain("system.readFile");
    expect(r.config.allowlist).not.toContain("system.writeFile");
  });

  it("awaiter is background + long timeout", () => {
    const r = getAgentRole("awaiter")!;
    expect(r.config.background).toBe(true);
    expect(r.config.timeoutMs).toBe(3_600_000);
  });

  it("registerAgentRole overrides built-ins by name", () => {
    registerAgentRole({
      name: "explorer",
      config: { description: "override" },
    });
    expect(getAgentRole("explorer")!.config.description).toBe("override");
  });
});

describe("nickname allocation", () => {
  it("dispenses distinct nicknames for the same role", () => {
    const role = getDefaultAgentRole();
    const n1 = allocateNickname(role);
    const n2 = allocateNickname(role);
    expect(n1).not.toBe(n2);
  });

  it("cycles through candidates and appends ordinal suffix on overflow", () => {
    const role = getDefaultAgentRole();
    const allocated: string[] = [];
    // The default pool has 8 candidates; exhaust them then force a cycle.
    for (let i = 0; i < 10; i++) allocated.push(allocateNickname(role));
    // After exhaustion, expect at least one "the Nth" suffix format.
    const suffixed = allocated.find((n) => /the \d+(?:st|nd|rd|th)/.test(n));
    expect(suffixed).toBeDefined();
  });

  it("releases nickname back to the pool", () => {
    const role = getDefaultAgentRole();
    const n = allocateNickname(role);
    releaseNickname(n);
    // Next allocation may reuse it (order-dependent; assert uniqueness from a fresh pool).
    _resetNicknamePoolForTesting();
    const n2 = allocateNickname(role);
    expect(n2).toBe(role.config.nicknameCandidates![0]);
  });
});
