import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

let registry: AgentRegistry;

function restoreBuiltInRoles(): void {
  registerAgentRole({
    name: "explorer",
    config: {
      description: "Fast codebase exploration.",
      configFile: "explorer.toml",
      nicknameCandidates: ["scout", "ranger", "pathfinder", "seeker"],
    },
  });
  registerAgentRole({
    name: "worker",
    config: {
      description:
        "Execution/production work — implement features, fix tests/bugs, " +
        "split large refactors.",
      nicknameCandidates: ["builder", "smith", "forge", "weaver"],
    },
  });
  registerAgentRole({
    name: "awaiter",
    config: {
      description: "Long-running polling subagent.",
      configFile: "awaiter.toml",
      background: true,
      nicknameCandidates: ["sentinel", "watcher", "guardian", "keeper"],
    },
  });
}

beforeEach(() => {
  registry = new AgentRegistry();
  restoreBuiltInRoles();
});

describe("role registry", () => {
  it("returns built-in default when name is undefined", () => {
    const role = resolveAgentRole(undefined);
    expect(role.name).toBe("default");
    expect(role.config.nicknameCandidates).toContain("alpha");
  });

  it("falls back to default for unknown role names", () => {
    expect(resolveAgentRole("unknown-role").name).toBe("default");
  });

  it("lists all built-in roles", () => {
    const names = listAgentRoles().map((role) => role.name);
    expect(names).toContain("default");
    expect(names).toContain("explorer");
    expect(names).toContain("worker");
    expect(names).toContain("awaiter");
  });

  it("explorer resolves through codex-shaped config-file metadata instead of AgenC-only overlays", () => {
    const role = getAgentRole("explorer")!;
    expect(role.config.configFile).toBe("explorer.toml");
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.allowlist).toBeUndefined();
  });

  it("worker keeps nickname metadata but no built-in config-layer override", () => {
    const role = resolveAgentRole("worker");
    expect(role.name).toBe("worker");
    expect(role.config.configFile).toBeUndefined();
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.nicknameCandidates).toEqual([
      "builder",
      "smith",
      "forge",
      "weaver",
    ]);
  });

  it("awaiter derives runtime hints from built-in TOML while keeping background orchestration metadata", () => {
    const role = getAgentRole("awaiter")!;
    expect(role.config.background).toBe(true);
    expect(role.config.reasoningEffort).toBe("low");
    expect(role.config.timeoutMs).toBe(3_600_000);
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
    const first = allocateNickname(role, registry);
    const second = allocateNickname(role, registry);
    expect(first).not.toBe(second);
  });

  it("cycles through candidates and appends ordinal suffix on overflow", () => {
    const role = getDefaultAgentRole();
    const allocated: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      allocated.push(allocateNickname(role, registry));
    }
    expect(
      allocated.find((nickname) => /the \d+(?:st|nd|rd|th)/.test(nickname)),
    ).toBeDefined();
  });

  it("releases nickname back into the registry pool", () => {
    const role = getDefaultAgentRole();
    const nickname = allocateNickname(role, registry);
    expect(registry.hasNickname(nickname)).toBe(true);
    releaseNickname(registry, nickname);
    expect(registry.hasNickname(nickname)).toBe(false);

    const freshRegistry = new AgentRegistry();
    const recycled = allocateNickname(role, freshRegistry);
    expect(recycled).toBe(role.config.nicknameCandidates![0]);
  });

  it("registry is the single source of truth — no double bookkeeping", () => {
    const role = getDefaultAgentRole();
    const nickname = allocateNickname(role, registry);
    expect(registry.hasNickname(nickname)).toBe(true);
    releaseNickname(registry, nickname);
    expect(registry.hasNickname(nickname)).toBe(false);
    expect(allocateNickname(role, registry)).toBe(role.config.nicknameCandidates![0]);
  });

  it("two sibling spawns from the same role get distinct nicknames", () => {
    const role = resolveAgentRole("worker");
    const first = allocateNickname(role, registry);
    const second = allocateNickname(role, registry);
    expect(first).not.toBe(second);
    expect(role.config.nicknameCandidates).toContain(first);
    expect(role.config.nicknameCandidates).toContain(second);
  });
});

describe("config-layer stack", () => {
  it("applyRoleToConfig keeps explorer as a no-op when explorer.toml is empty", () => {
    const explorer = getAgentRole("explorer")!;
    const base = { cwd: "/tmp/project", reasoning_effort: "high" as const };
    const next = applyRoleToConfig(explorer, base);
    expect(next).toEqual(base);
    expect(base.reasoning_effort).toBe("high");
  });

  it("applyRoleToConfig parses codex TOML aliases into canonical AgenC config keys", () => {
    registerAgentRole({
      name: "custom-inline",
      config: {
        description: "inline role",
        configToml: [
          'model = "role-model"',
          'model_reasoning_effort = "high"',
          'name = "ignored-role-metadata"',
          'developer_instructions = "ignored"',
        ].join("\n"),
      },
    });

    const base = { cwd: "/tmp/project" };
    const next = applyRoleToConfig(getAgentRole("custom-inline")!, base);
    expect(next.cwd).toBe("/tmp/project");
    expect(next.model).toBe("role-model");
    expect(next.reasoning_effort).toBe("high");
    expect("name" in next).toBe(false);
    expect("developer_instructions" in next).toBe(false);
  });

  it("buildConfigLayerStack applies base → role → user precedence", () => {
    registerAgentRole({
      name: "custom-precedence",
      config: {
        description: "precedence role",
        configToml: [
          'model = "role-model"',
          'model_reasoning_effort = "low"',
        ].join("\n"),
      },
    });

    const effective = buildConfigLayerStack({
      base: { cwd: "/x", model: "base-model" },
      roleName: "custom-precedence",
      userLayer: { model: "user-model" },
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.model).toBe("user-model");
    expect(effective.reasoning_effort).toBe("low");
  });

  it("buildConfigLayerStack resolves a role-selected profile against the merged config", () => {
    registerAgentRole({
      name: "profile-role",
      config: {
        description: "profile role",
        configToml: 'profile = "fast"',
      },
    });

    const effective = buildConfigLayerStack({
      base: {
        cwd: "/x",
        profiles: {
          fast: {
            model: "fast-model",
            approval_policy: "never",
          },
        },
      },
      roleName: "profile-role",
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.model).toBe("fast-model");
    expect(effective.approval_policy).toBe("never");
  });

  it("buildConfigLayerStack leaves unknown roles unchanged except for the user overlay", () => {
    const effective = buildConfigLayerStack({
      base: { cwd: "/x", reasoning_effort: "medium" as const },
      roleName: "missing-role",
      userLayer: { mode: "user-overlay" },
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.reasoning_effort).toBe("medium");
    expect(effective.mode).toBe("user-overlay");
  });

  it("tryResolveRoleConfig returns undefined for unknown; resolveAgentRole falls back to default", () => {
    expect(tryResolveRoleConfig("unknown")).toBeUndefined();
    expect(tryResolveRoleConfig(undefined)).toBeUndefined();
    expect(tryResolveRoleConfig("explorer")).toBeDefined();
    expect(resolveAgentRole("unknown").name).toBe("default");
  });

  it("loadRoleLayerToml reads built-in TOML and strips user-role metadata from disk-backed TOML", () => {
    expect(loadRoleLayerToml(getAgentRole("explorer")!)).toEqual({});

    const dir = mkdtempSync(join(tmpdir(), "agenc-role-test-"));
    const path = join(dir, "custom-role.toml");
    writeFileSync(
      path,
      [
        'name = "custom"',
        'description = "Custom description"',
        'nickname_candidates = ["one"]',
        'developer_instructions = "ignored"',
        'model = "file-model"',
        'model_reasoning_effort = "medium"',
      ].join("\n"),
    );

    registerAgentRole({
      name: "file-backed-role",
      config: {
        description: "file-backed role",
        configFile: path,
      },
    });

    expect(loadRoleLayerToml(getAgentRole("file-backed-role")!)).toEqual({
      model: "file-model",
      model_reasoning_effort: "medium",
    });
  });

  it("formatRoleList uses codex-style locked-setting notes from role TOML", () => {
    registerAgentRole({
      name: "model-locked-role",
      config: {
        description: "Locked config role.",
        configToml: [
          'model = "gpt-test"',
          'model_reasoning_effort = "high"',
        ].join("\n"),
      },
    });

    const text = formatRoleList([
      getDefaultAgentRole(),
      getAgentRole("model-locked-role")!,
    ]);

    expect(text).toContain("Available roles:");
    expect(text).toContain("default");
    expect(text).toContain("Default agent.");
    expect(text).toContain("model-locked-role:");
    expect(text).toContain("model is set to `gpt-test`");
    expect(text).toContain("reasoning effort is set to `high`");
  });

  it("formatRoleList skips duplicate names", () => {
    const explorer = getAgentRole("explorer")!;
    const text = formatRoleList([explorer, explorer]);
    expect(text.match(/explorer:/g)?.length).toBe(1);
  });
});
