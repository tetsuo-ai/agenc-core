import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import {
  _resetAgentRolesForTesting,
  allocateNickname,
  applyRoleToConfig,
  buildConfigLayerStack,
  defaultAgentNicknameCandidates,
  formatRoleList,
  getAgentRole,
  getDefaultAgentRole,
  listAgentRoles,
  loadMarkdownAgentRoles,
  loadRoleLayerToml,
  registerAgentRole,
  releaseNickname,
  requireAgentRole,
  resolveAgentRole,
  tryResolveRoleConfig,
} from "./role.js";

let registry: AgentRegistry;

beforeEach(() => {
  registry = new AgentRegistry();
  _resetAgentRolesForTesting();
});

describe("role registry", () => {
  it("returns built-in default when name is undefined", () => {
    const role = resolveAgentRole(undefined);
    expect(role.name).toBe("default");
    expect(role.config.nicknameCandidates).toBeUndefined();
    expect(defaultAgentNicknameCandidates()).toContain("Snowcrash");
  });

  it("falls back to default for unknown role names", () => {
    expect(resolveAgentRole("unknown-role").name).toBe("default");
  });

  it("strict spawn role lookup rejects unrecognized agent_type", () => {
    expect(() => requireAgentRole("missing-role")).toThrow(
      "unknown agent_type 'missing-role'",
    );
    expect(requireAgentRole("runner").name).toBe("worker");
  });

  it("lists all built-in roles", () => {
    const names = listAgentRoles().map((role) => role.name);
    expect(names).toContain("default");
    expect(names).toContain("explorer");
    expect(names).toContain("worker");
    // Promoted built-in roles (formerly stranded const agents).
    expect(names).toContain("Plan");
    expect(names).toContain("verification");
    expect(names).not.toContain("awaiter");
  });

  it("resolves promoted built-in agents (scanner/Explore, Plan, verification)", () => {
    // The Explore agent folds into the explorer/scanner role.
    for (const name of ["explorer", "scanner", "Explore", "explore"]) {
      expect(requireAgentRole(name).name).toBe("explorer");
    }
    // Plan's capital registry key is reachable only via the `plan` alias,
    // because spawn lowercases the requested name before lookup.
    expect(requireAgentRole("Plan").name).toBe("Plan");
    expect(requireAgentRole("plan").name).toBe("Plan");
    expect(requireAgentRole("verification").name).toBe("verification");
    // general-purpose is an alias of the default role.
    expect(requireAgentRole("general-purpose").name).toBe("default");
    expect(getDefaultAgentRole().name).toBe("default");
  });

  it("carries promoted built-in behavior on role config", () => {
    const explorer = requireAgentRole("scanner");
    expect(explorer.config.systemPrompt).toContain("file search specialist");
    expect(explorer.config.disallowlist).toContain("spawn_agent");
    expect(explorer.config.disallowlist).toContain("Edit");
    expect(explorer.config.disallowlist).toContain("Write");
    // Navigate-first guidance (revert-sensitive): structural-map-first, read
    // spans not whole files, and skip generated/build dirs.
    expect(explorer.config.systemPrompt).toContain("structural map FIRST");
    expect(explorer.config.systemPrompt).toContain("targeted spans");
    expect(explorer.config.systemPrompt).toMatch(/Skip generated\/build\/vendored/);

    const plan = requireAgentRole("Plan");
    expect(plan.config.systemPrompt).toContain("software architect");
    expect(plan.config.disallowlist).toContain("Write");

    const verification = requireAgentRole("verification");
    expect(verification.config.background).toBe(true);
    expect(verification.config.disallowlist).toContain("Edit");
    expect(verification.config.systemPrompt).toContain("VERDICT:");

    // The default/general-purpose role is unrestricted (no denylist) and carries
    // no system prompt — it is also used by internal silent default-role spawns,
    // so a subagent prompt must not ride along.
    const def = requireAgentRole("general-purpose");
    expect(def.name).toBe("default");
    expect(def.config.systemPrompt).toBeUndefined();
    expect(def.config.disallowlist).toBeUndefined();
  });

  it("explorer resolves through upstream-compatible config-file metadata", () => {
    const role = getAgentRole("explorer")!;
    expect(role.config.configFile).toBe("explorer.toml");
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.allowlist).toBeUndefined();
    expect(role.config.description).toContain(
      "Scanners are fast and authoritative",
    );
  });

  it("accepts cyberpunk role aliases without changing compatibility ids", () => {
    expect(getAgentRole("scanner")?.name).toBe("explorer");
    expect(resolveAgentRole("runner").name).toBe("worker");
  });

  it("worker has the default description and no built-in config-layer override", () => {
    const role = resolveAgentRole("worker");
    expect(role.name).toBe("worker");
    expect(role.config.configFile).toBeUndefined();
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.nicknameCandidates).toBeUndefined();
    expect(role.config.description).toContain(
      "Use `runner` for execution and production work",
    );
  });

  it("user-registered awaiter roles can still derive runtime hints from built-in TOML", () => {
    registerAgentRole({
      name: "awaiter",
      config: {
        description: "Custom awaiter",
        configFile: "awaiter.toml",
        background: true,
      },
    });
    const role = getAgentRole("awaiter")!;
    expect(role.config.background).toBe(true);
    expect(role.config.reasoningEffort).toBe("low");
    expect(role.config.timeoutMs).toBe(3_600_000);
  });

  it("derives xhigh reasoning effort from user role layers", () => {
    registerAgentRole({
      name: "deep-review",
      config: {
        description: "review",
        configToml: 'model_reasoning_effort = "xhigh"',
      },
    });

    expect(getAgentRole("deep-review")?.config.reasoningEffort).toBe("xhigh");
  });

  it("derives model and service tier hints from user role layers", () => {
    registerAgentRole({
      name: "priority-review",
      config: {
        description: "review",
        configToml: [
          'model = "gpt-5.4"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });

    expect(getAgentRole("priority-review")?.config.model).toBe("gpt-5.4");
    expect(getAgentRole("priority-review")?.config.serviceTier).toBe("priority");
  });

  it("registerAgentRole overrides built-ins by name", () => {
    registerAgentRole({
      name: "explorer",
      config: { description: "override" },
    });
    expect(getAgentRole("explorer")!.config.description).toBe("override");
  });

  it("registers project markdown agents into the spawn_agent role registry", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-markdown-role-"));
    const dir = join(root, ".agenc", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "reviewer.md"),
      [
        "---",
        "name: project-reviewer",
        "description: Project reviewer",
        "tools:",
        "  - Read",
        "effort: high",
        "---",
        "Review the current project changes.",
      ].join("\n"),
    );

    loadMarkdownAgentRoles(root);

    const role = requireAgentRole("project-reviewer");
    expect(role.config.description).toBe("Project reviewer");
    expect(role.config.systemPrompt).toBe("Review the current project changes.");
    expect(role.config.allowlist).toEqual(["Read"]);
    expect(role.config.reasoningEffort).toBe("high");
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
    const role = {
      name: "tiny",
      config: {
        nicknameCandidates: ["one", "two"],
      },
    };
    const allocated: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      allocated.push(allocateNickname(role, registry));
    }
    expect(
      allocated.find((nickname) => /the \d+(?:st|nd|rd|th)/.test(nickname)),
    ).toBeDefined();
  });

  it("releases nickname back into the registry pool", () => {
    const role = {
      name: "tiny",
      config: {
        nicknameCandidates: ["one"],
      },
    };
    const nickname = allocateNickname(role, registry);
    expect(registry.hasNickname(nickname)).toBe(true);
    releaseNickname(registry, nickname);
    expect(registry.hasNickname(nickname)).toBe(false);

    const recycled = allocateNickname(role, registry);
    expect(recycled).toBe("one");
  });

  it("registry is the single source of truth — no double bookkeeping", () => {
    const role = {
      name: "tiny",
      config: {
        nicknameCandidates: ["one"],
      },
    };
    const nickname = allocateNickname(role, registry);
    expect(registry.hasNickname(nickname)).toBe(true);
    releaseNickname(registry, nickname);
    expect(registry.hasNickname(nickname)).toBe(false);
    expect(allocateNickname(role, registry)).toBe("one");
  });

  it("two sibling spawns from roles without candidate lists use distinct shared nicknames", () => {
    const role = resolveAgentRole("worker");
    const first = allocateNickname(role, registry);
    const second = allocateNickname(role, registry);
    expect(first).not.toBe(second);
    expect(defaultAgentNicknameCandidates()).toContain(first);
    expect(defaultAgentNicknameCandidates()).toContain(second);
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

  it("applyRoleToConfig parses AgenC TOML aliases into canonical AgenC config keys", () => {
    registerAgentRole({
      name: "custom-inline",
      config: {
        description: "inline role",
        configToml: [
          'model = "role-model"',
          'model_reasoning_effort = "high"',
          'service_tier = "priority"',
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
    expect(next.service_tier).toBe("priority");
    expect("name" in next).toBe(false);
    expect("developer_instructions" in next).toBe(false);
  });

  it("applyRoleToConfig preserves the parent service tier when the role does not override it", () => {
    registerAgentRole({
      name: "custom-inline",
      config: {
        description: "inline role",
        configToml: 'model = "role-model"',
      },
    });

    const base = { cwd: "/tmp/project", service_tier: "priority" as const };
    const next = applyRoleToConfig(getAgentRole("custom-inline")!, base);
    expect(next.service_tier).toBe("priority");
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

  it("formatRoleList uses AgenC-style locked-setting notes from role TOML", () => {
    registerAgentRole({
      name: "model-locked-role",
      config: {
        description: "Locked config role.",
        configToml: [
          'model = "gpt-test"',
          'model_reasoning_effort = "high"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });

    const text = formatRoleList([
      getDefaultAgentRole(),
      getAgentRole("model-locked-role")!,
    ]);

    expect(text).toContain("Available roles:");
    expect(text).toContain("netrunner");
    expect(text).toContain("Default agent.");
    expect(text).toContain("model-locked-role:");
    expect(text).toContain("model is set to `gpt-test`");
    expect(text).toContain("reasoning effort is set to `high`");
    expect(text).toContain("service tier is set to `priority`");
    expect(text).toContain(
      "takes precedence over a valid spawn request service tier",
    );
  });

  it("formatRoleList skips duplicate names", () => {
    const explorer = getAgentRole("explorer")!;
    const text = formatRoleList([explorer, explorer]);
    expect(text.match(/scanner:/g)?.length).toBe(1);
    expect(text).toContain("Legacy alias accepted: `explorer`");
  });
});
