import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import {
  _resetAgentRolesForTesting,
  agentRoleFingerprint,
  allocateNickname,
  applyRoleToConfig,
  buildConfigLayerStack,
  createAgentRoleWorkspace,
  defaultAgentNicknameCandidates,
  formatRoleList,
  getAgentRole,
  getDefaultAgentRole,
  listAgentRoles,
  loadRoleLayerToml,
  registerAgentRole,
  releaseNickname,
  requireAgentRole,
  resolveAgentRole,
  tryResolveRoleConfig,
} from "./role.js";

let registry: AgentRegistry;
const DEFAULT_WORKSPACE = createAgentRoleWorkspace(process.cwd());

beforeEach(() => {
  registry = new AgentRegistry();
  _resetAgentRolesForTesting();
});

describe("role registry", () => {
  it("rejects a missing or relative role workspace", () => {
    expect(() => createAgentRoleWorkspace("")).toThrow(
      "agent role workspace requires a non-empty absolute cwd",
    );
    expect(() => createAgentRoleWorkspace("relative/project")).toThrow(
      "agent role workspace cwd must be absolute",
    );
  });

  it("returns built-in default when name is undefined", () => {
    const role = resolveAgentRole(DEFAULT_WORKSPACE, undefined);
    expect(role.name).toBe("default");
    expect(role.config.nicknameCandidates).toBeUndefined();
    expect(defaultAgentNicknameCandidates()).toContain("Snowcrash");
  });

  it("falls back to default for unknown role names", () => {
    expect(resolveAgentRole(DEFAULT_WORKSPACE, "unknown-role").name).toBe("default");
  });

  it("strict spawn role lookup rejects unrecognized agent_type", () => {
    expect(() => requireAgentRole(DEFAULT_WORKSPACE, "missing-role")).toThrow(
      "unknown agent_type 'missing-role'",
    );
    expect(requireAgentRole(DEFAULT_WORKSPACE, "runner").name).toBe("runner");
  });

  it("lists all built-in roles", () => {
    const names = listAgentRoles(DEFAULT_WORKSPACE).map((role) => role.name);
    expect(names).toContain("default");
    expect(names).toContain("scanner");
    expect(names).toContain("runner");
    // Promoted built-in roles (formerly stranded const agents).
    expect(names).toContain("Plan");
    expect(names).toContain("verification");
    expect(names).not.toContain("awaiter");
  });

  it("resolves promoted built-in agents (scanner, Plan, verification)", () => {
    for (const name of ["scanner", "Explore", "explore"]) {
      expect(requireAgentRole(DEFAULT_WORKSPACE, name).name).toBe("scanner");
    }
    // Plan's capital registry key is reachable only via the `plan` alias,
    // because spawn lowercases the requested name before lookup.
    expect(requireAgentRole(DEFAULT_WORKSPACE, "Plan").name).toBe("Plan");
    expect(requireAgentRole(DEFAULT_WORKSPACE, "plan").name).toBe("Plan");
    expect(requireAgentRole(DEFAULT_WORKSPACE, "verification").name).toBe("verification");
    // general-purpose is an alias of the default role.
    expect(requireAgentRole(DEFAULT_WORKSPACE, "general-purpose").name).toBe("default");
    expect(getDefaultAgentRole().name).toBe("default");
  });

  it.each(["explorer", "worker"])(
    "rejects retired built-in role id %s",
    (roleName) => {
      expect(getAgentRole(DEFAULT_WORKSPACE, roleName)).toBeUndefined();
      expect(() => requireAgentRole(DEFAULT_WORKSPACE, roleName)).toThrow(
        `unknown agent_type '${roleName}'`,
      );
    },
  );

  it("carries promoted built-in behavior on role config", () => {
    const scanner = requireAgentRole(DEFAULT_WORKSPACE, "scanner");
    expect(scanner.config.systemPrompt).toContain("file search specialist");
    expect(scanner.config.disallowlist).toContain("spawn_agent");
    expect(scanner.config.disallowlist).toContain("Edit");
    expect(scanner.config.disallowlist).toContain("Write");
    // Navigate-first guidance (revert-sensitive): structural-map-first, read
    // spans not whole files, and skip generated/build dirs.
    expect(scanner.config.systemPrompt).toContain("structural map FIRST");
    expect(scanner.config.systemPrompt).toContain("targeted spans");
    expect(scanner.config.systemPrompt).toMatch(/Skip generated\/build\/vendored/);

    const plan = requireAgentRole(DEFAULT_WORKSPACE, "Plan");
    expect(plan.config.systemPrompt).toContain("software architect");
    expect(plan.config.disallowlist).toContain("Write");

    const verification = requireAgentRole(DEFAULT_WORKSPACE, "verification");
    expect(verification.config.background).toBe(true);
    expect(verification.config.disallowlist).toContain("Edit");
    expect(verification.config.systemPrompt).toContain("VERDICT:");

    // The default/general-purpose role is unrestricted (no denylist) and carries
    // no system prompt — it is also used by internal silent default-role spawns,
    // so a subagent prompt must not ride along.
    const def = requireAgentRole(DEFAULT_WORKSPACE, "general-purpose");
    expect(def.name).toBe("default");
    expect(def.config.systemPrompt).toBeUndefined();
    expect(def.config.disallowlist).toBeUndefined();
  });

  it("scanner resolves through upstream-compatible config-file metadata", () => {
    const role = getAgentRole(DEFAULT_WORKSPACE, "scanner")!;
    expect(role.config.configFile).toBe("scanner.toml");
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.allowlist).toBeUndefined();
    expect(role.config.description).toContain(
      "Scanners are fast and authoritative",
    );
  });

  it("uses the public role names as canonical registry ids", () => {
    expect(getAgentRole(DEFAULT_WORKSPACE, "scanner")?.name).toBe("scanner");
    expect(resolveAgentRole(DEFAULT_WORKSPACE, "runner").name).toBe("runner");
  });

  it("runner has the default description and no built-in config-layer override", () => {
    const role = resolveAgentRole(DEFAULT_WORKSPACE, "runner");
    expect(role.name).toBe("runner");
    expect(role.config.configFile).toBeUndefined();
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.nicknameCandidates).toBeUndefined();
    expect(role.config.description).toContain(
      "Use `runner` for execution and production work",
    );
  });

  it("user-registered awaiter roles can still derive runtime hints from built-in TOML", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "awaiter",
      config: {
        description: "Custom awaiter",
        configFile: "awaiter.toml",
        background: true,
      },
    });
    const role = getAgentRole(DEFAULT_WORKSPACE, "awaiter")!;
    expect(role.config.background).toBe(true);
    expect(role.config.reasoningEffort).toBe("low");
    expect(role.config.timeoutMs).toBeUndefined();
  });

  it("derives xhigh reasoning effort from user role layers", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "deep-review",
      config: {
        description: "review",
        configToml: 'reasoning_effort = "xhigh"',
      },
    });

    expect(getAgentRole(DEFAULT_WORKSPACE, "deep-review")?.config.reasoningEffort).toBe("xhigh");
  });

  it("rejects obsolete config aliases in active role layers", () => {
    expect(() =>
      registerAgentRole(DEFAULT_WORKSPACE, {
        name: "obsolete-role-config",
        config: {
          description: "review",
          configToml: 'model_reasoning_effort = "high"',
        },
      })
    ).toThrow(/unknown schema-v2 keys: model_reasoning_effort/u);
  });

  it("derives model and service tier hints from user role layers", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "priority-review",
      config: {
        description: "review",
        configToml: [
          'model = "gpt-5.4"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });

    expect(getAgentRole(DEFAULT_WORKSPACE, "priority-review")?.config.model).toBe("gpt-5.4");
    expect(getAgentRole(DEFAULT_WORKSPACE, "priority-review")?.config.serviceTier).toBe("priority");
  });

  it("registerAgentRole overrides built-ins by name", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "scanner",
      config: { description: "override" },
    });
    expect(getAgentRole(DEFAULT_WORKSPACE, "scanner")!.config.description).toBe("override");
  });

  it("keeps same-named programmatic roles inside their workspace", () => {
    const workspaceA = createAgentRoleWorkspace("/tmp/agenc-role-registry-a");
    const workspaceB = createAgentRoleWorkspace("/tmp/agenc-role-registry-b");
    registerAgentRole(workspaceA, {
      name: "shared-reviewer",
      config: { description: "Programmatic reviewer A" },
    });
    registerAgentRole(workspaceB, {
      name: "shared-reviewer",
      config: { description: "Programmatic reviewer B" },
    });

    expect(getAgentRole(workspaceA, "shared-reviewer")?.config.description).toBe(
      "Programmatic reviewer A",
    );
    expect(getAgentRole(workspaceB, "shared-reviewer")?.config.description).toBe(
      "Programmatic reviewer B",
    );
    expect(getAgentRole(DEFAULT_WORKSPACE, "shared-reviewer")).toBeUndefined();
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
    const role = resolveAgentRole(DEFAULT_WORKSPACE, "runner");
    const first = allocateNickname(role, registry);
    const second = allocateNickname(role, registry);
    expect(first).not.toBe(second);
    expect(defaultAgentNicknameCandidates()).toContain(first);
    expect(defaultAgentNicknameCandidates()).toContain(second);
  });
});

describe("config-layer stack", () => {
  it("applyRoleToConfig keeps scanner as a no-op when scanner.toml is empty", () => {
    const scanner = getAgentRole(DEFAULT_WORKSPACE, "scanner")!;
    const base = { cwd: "/tmp/project", reasoning_effort: "high" as const };
    const next = applyRoleToConfig(scanner, base);
    expect(next).toEqual(base);
    expect(base.reasoning_effort).toBe("high");
  });

  it("applyRoleToConfig accepts canonical AgenC config keys", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "custom-inline",
      config: {
        description: "inline role",
        configToml: [
          'model = "role-model"',
          'reasoning_effort = "high"',
          'service_tier = "priority"',
          'name = "ignored-role-metadata"',
          'developer_instructions = "ignored"',
        ].join("\n"),
      },
    });

    const base = { cwd: "/tmp/project" };
    const next = applyRoleToConfig(
      getAgentRole(DEFAULT_WORKSPACE, "custom-inline")!,
      base,
    );
    expect(next.cwd).toBe("/tmp/project");
    expect(next.model).toBe("role-model");
    expect(next.reasoning_effort).toBe("high");
    expect(next.service_tier).toBe("priority");
    expect("name" in next).toBe(false);
    expect("developer_instructions" in next).toBe(false);
  });

  it("applyRoleToConfig preserves the parent service tier when the role does not override it", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "custom-inline",
      config: {
        description: "inline role",
        configToml: 'model = "role-model"',
      },
    });

    const base = { cwd: "/tmp/project", service_tier: "priority" as const };
    const next = applyRoleToConfig(
      getAgentRole(DEFAULT_WORKSPACE, "custom-inline")!,
      base,
    );
    expect(next.service_tier).toBe("priority");
  });

  it("buildConfigLayerStack applies base → role → user precedence", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "custom-precedence",
      config: {
        description: "precedence role",
        configToml: [
          'model = "role-model"',
          'reasoning_effort = "low"',
        ].join("\n"),
      },
    });

    const effective = buildConfigLayerStack({
      base: { cwd: "/x", model: "base-model" },
      workspace: DEFAULT_WORKSPACE,
      roleName: "custom-precedence",
      userLayer: { model: "user-model" },
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.model).toBe("user-model");
    expect(effective.reasoning_effort).toBe("low");
  });

  it("buildConfigLayerStack resolves a role-selected profile against the merged config", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
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
      workspace: DEFAULT_WORKSPACE,
      roleName: "profile-role",
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.model).toBe("fast-model");
    expect(effective.approval_policy).toBe("never");
  });

  it("buildConfigLayerStack leaves unknown roles unchanged except for the user overlay", () => {
    const effective = buildConfigLayerStack({
      base: { cwd: "/x", reasoning_effort: "medium" as const },
      workspace: DEFAULT_WORKSPACE,
      roleName: "missing-role",
      userLayer: { mode: "user-overlay" },
    });

    expect(effective.cwd).toBe("/x");
    expect(effective.reasoning_effort).toBe("medium");
    expect(effective.mode).toBe("user-overlay");
  });

  it("tryResolveRoleConfig returns undefined for unknown; resolveAgentRole falls back to default", () => {
    expect(tryResolveRoleConfig(DEFAULT_WORKSPACE, "unknown")).toBeUndefined();
    expect(tryResolveRoleConfig(DEFAULT_WORKSPACE, undefined)).toBeUndefined();
    expect(tryResolveRoleConfig(DEFAULT_WORKSPACE, "scanner")).toBeDefined();
    expect(resolveAgentRole(DEFAULT_WORKSPACE, "unknown").name).toBe("default");
  });

  it("loadRoleLayerToml reads built-in TOML and strips user-role metadata from disk-backed TOML", () => {
    expect(
      loadRoleLayerToml(getAgentRole(DEFAULT_WORKSPACE, "scanner")!),
    ).toEqual({});

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
        'reasoning_effort = "medium"',
      ].join("\n"),
    );

    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "file-backed-role",
      config: {
        description: "file-backed role",
        configFile: path,
      },
    });

    expect(
      loadRoleLayerToml(getAgentRole(DEFAULT_WORKSPACE, "file-backed-role")!),
    ).toEqual({
      model: "file-model",
      reasoning_effort: "medium",
    });
  });

  it("fingerprints the effective contents of a same-path role config", () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-role-fingerprint-"));
    const path = join(dir, "guarded.toml");
    writeFileSync(path, 'approval_policy = "never"\n');
    const role = {
      name: "guarded",
      config: {
        description: "Guarded role",
        configFile: path,
      },
    };

    const first = agentRoleFingerprint(role);
    writeFileSync(path, 'approval_policy = "on-request"\n');
    expect(agentRoleFingerprint(role)).not.toBe(first);
  });

  it("formatRoleList uses AgenC-style locked-setting notes from role TOML", () => {
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "model-locked-role",
      config: {
        description: "Locked config role.",
        configToml: [
          'model = "gpt-test"',
          'reasoning_effort = "high"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });

    const text = formatRoleList([
      getDefaultAgentRole(),
      getAgentRole(DEFAULT_WORKSPACE, "model-locked-role")!,
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
    const scanner = getAgentRole(DEFAULT_WORKSPACE, "scanner")!;
    const text = formatRoleList([scanner, scanner]);
    expect(text.match(/scanner:/g)?.length).toBe(1);
    expect(text).not.toContain("Legacy alias accepted");
  });
});
