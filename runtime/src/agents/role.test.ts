import { beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import {
  allocateNickname,
  applyRoleToConfig,
  buildConfigLayerStack,
  formatRoleList,
  getAgentRole,
  getDefaultAgentRole,
  listAgentRoles,
  loadRoleLayerToml,
  registerAgentRole,
  releaseNickname,
  resolveAgentRole,
  tryResolveRoleConfig,
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

describe("config-layer stack (Wave 3 port)", () => {
  // The earlier `registerAgentRole overrides built-ins by name` test
  // mutates the module-level registry; restore a clean explorer so
  // this suite's assertions are not coupled to run order.
  beforeEach(() => {
    registerAgentRole({
      name: "explorer",
      config: {
        description: "Fast codebase exploration.",
        reasoningEffort: "low",
        allowlist: ["system.readFile", "system.listDir"],
        nicknameCandidates: ["scout", "ranger", "pathfinder", "seeker"],
      },
    });
  });

  it("applyRoleToConfig(explorer) sets reasoning=low + projects allowlist", () => {
    const explorer = getAgentRole("explorer")!;
    const base = { cwd: "/tmp/project" };
    const next = applyRoleToConfig(explorer, base);
    expect(next.reasoningEffort).toBe("low");
    expect(next.allowlist).toContain("system.readFile");
    // Base sibling fields pass through untouched.
    expect(next.cwd).toBe("/tmp/project");
    // applyRoleToConfig is pure — base stays unchanged.
    expect((base as { reasoningEffort?: string }).reasoningEffort).toBeUndefined();
  });

  it("applyRoleToConfig does not rewrite fields the role doesn't set", () => {
    const defaultRole = getDefaultAgentRole();
    const base = { reasoningEffort: "high" as const, cwd: "/x" };
    const next = applyRoleToConfig(defaultRole, base);
    // default role sets no reasoningEffort — base value sticks.
    expect(next.reasoningEffort).toBe("high");
    expect(next.cwd).toBe("/x");
  });

  it("buildConfigLayerStack: user layer overrides role layer", () => {
    const base = { cwd: "/x" };
    const effective = buildConfigLayerStack({
      base,
      roleName: "explorer",
      userLayer: { reasoningEffort: "high" },
    });
    // role says low, user says high → user wins.
    expect(effective.reasoningEffort).toBe("high");
    // role-layer allowlist still flows through (user didn't touch it).
    expect(effective.allowlist).toContain("system.readFile");
  });

  it("buildConfigLayerStack: base-role-user precedence", () => {
    const base = {
      cwd: "/x",
      reasoningEffort: "medium" as const,
      timeoutMs: 1000,
    };
    const effective = buildConfigLayerStack({
      base,
      roleName: "awaiter",
      userLayer: { timeoutMs: 42 },
    });
    // awaiter projects background=true, reasoning=low, timeout=3_600_000.
    // user layer then overrides timeoutMs → 42.
    expect(effective.reasoningEffort).toBe("low");
    expect(effective.background).toBe(true);
    expect(effective.timeoutMs).toBe(42);
    // base cwd still intact (not a role-override field).
    expect(effective.cwd).toBe("/x");
  });

  it("buildConfigLayerStack: unknown role leaves base unchanged except user overlay", () => {
    const base = { cwd: "/x", reasoningEffort: "medium" as const };
    const effective = buildConfigLayerStack({
      base,
      roleName: "nope-not-a-role",
      userLayer: { background: true },
    });
    expect(effective.reasoningEffort).toBe("medium");
    expect(effective.background).toBe(true);
    expect(effective.cwd).toBe("/x");
  });

  it("tryResolveRoleConfig returns undefined for unknown; resolveAgentRole falls back to default", () => {
    expect(tryResolveRoleConfig("unknown")).toBeUndefined();
    expect(tryResolveRoleConfig(undefined)).toBeUndefined();
    expect(tryResolveRoleConfig("explorer")).toBeDefined();
    expect(resolveAgentRole("unknown").name).toBe("default");
  });

  it("loadRoleLayerToml stub returns empty object (T10 TODO)", () => {
    const role = getAgentRole("explorer")!;
    expect(loadRoleLayerToml(role)).toEqual({});
  });

  it("formatRoleList produces a header + per-role summary", () => {
    const text = formatRoleList(listAgentRoles());
    expect(text).toContain("Available roles:");
    expect(text).toContain("default");
    expect(text).toContain("explorer:");
    // Capability hint line for explorer should mention low reasoning.
    expect(text).toMatch(/reasoning=low/);
    // Worker should appear in the listing.
    expect(text).toContain("worker:");
    // Default role's description is present.
    expect(text).toContain("Unrestricted subagent");
  });

  it("formatRoleList skips duplicate names", () => {
    const explorer = getAgentRole("explorer")!;
    const text = formatRoleList([explorer, explorer]);
    // explorer should appear exactly once.
    const matches = text.match(/explorer:/g);
    expect(matches?.length).toBe(1);
  });
});
