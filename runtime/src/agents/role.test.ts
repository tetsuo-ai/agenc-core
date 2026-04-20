import { beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import {
  allocateNickname,
  getAgentRole,
  getDefaultAgentRole,
  listAgentRoles,
  registerAgentRole,
  releaseNickname,
  resolveAgentRole,
} from "./role.js";

// Each suite gets a fresh registry — nicknames now live on the
// registry so there is no process-wide pool to reset.
let registry: AgentRegistry;

beforeEach(() => {
  registry = new AgentRegistry();
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

  it("lists all built-in roles (default, explorer, worker, awaiter)", () => {
    const names = listAgentRoles().map((r) => r.name);
    expect(names).toContain("default");
    expect(names).toContain("explorer");
    expect(names).toContain("worker");
    expect(names).toContain("awaiter");
  });

  it("explorer has read-only allowlist + low reasoning", () => {
    const r = getAgentRole("explorer")!;
    expect(r.config.reasoningEffort).toBe("low");
    expect(r.config.allowlist).toContain("system.readFile");
    expect(r.config.allowlist).not.toContain("system.writeFile");
  });

  it("worker resolves with medium reasoning + worker nickname pool + no allowlist", () => {
    const r = resolveAgentRole("worker");
    expect(r.name).toBe("worker");
    expect(r.config.reasoningEffort).toBe("medium");
    expect(r.config.allowlist).toBeUndefined();
    expect(r.config.nicknameCandidates).toEqual([
      "builder",
      "smith",
      "forge",
      "weaver",
    ]);
  });

  it("awaiter is background + long timeout (AgenC-only divergence from codex)", () => {
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
    const n1 = allocateNickname(role, registry);
    const n2 = allocateNickname(role, registry);
    expect(n1).not.toBe(n2);
  });

  it("cycles through candidates and appends ordinal suffix on overflow", () => {
    const role = getDefaultAgentRole();
    const allocated: string[] = [];
    // The default pool has 8 candidates; exhaust them then force a cycle.
    for (let i = 0; i < 10; i++) allocated.push(allocateNickname(role, registry));
    // After exhaustion, expect at least one "the Nth" suffix format.
    const suffixed = allocated.find((n) => /the \d+(?:st|nd|rd|th)/.test(n));
    expect(suffixed).toBeDefined();
  });

  it("releases nickname back into the registry pool", () => {
    const role = getDefaultAgentRole();
    const n = allocateNickname(role, registry);
    expect(registry.hasNickname(n)).toBe(true);
    releaseNickname(registry, n);
    expect(registry.hasNickname(n)).toBe(false);
    // A fresh registry returns the first candidate deterministically.
    const fresh = new AgentRegistry();
    const n2 = allocateNickname(role, fresh);
    expect(n2).toBe(role.config.nicknameCandidates![0]);
  });

  it("registry is the single source of truth — no double bookkeeping", () => {
    const role = getDefaultAgentRole();
    const n = allocateNickname(role, registry);
    expect(registry.hasNickname(n)).toBe(true);
    // Releasing via the free function clears the registry's set.
    releaseNickname(registry, n);
    expect(registry.hasNickname(n)).toBe(false);
    // Re-allocating on the same (now empty) pool yields the first
    // candidate again, proving there is no hidden second set
    // retaining the released name.
    const n2 = allocateNickname(role, registry);
    expect(n2).toBe(role.config.nicknameCandidates![0]);
  });

  it("two sibling spawns from the same role get distinct nicknames", () => {
    const role = resolveAgentRole("worker");
    const n1 = allocateNickname(role, registry);
    const n2 = allocateNickname(role, registry);
    expect(n1).not.toBe(n2);
    expect(role.config.nicknameCandidates).toContain(n1);
    expect(role.config.nicknameCandidates).toContain(n2);
  });
});
