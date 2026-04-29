import { mkdtempSync, writeFileSync } from "node:fs";
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
  loadRoleLayerToml,
  registerAgentRole,
  releaseNickname,
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
    expect(defaultAgentNicknameCandidates()).toContain("Euclid");
  });

  it("falls back to default for unknown role names", () => {
    expect(resolveAgentRole("unknown-role").name).toBe("default");
  });

  it("lists all built-in roles", () => {
    const names = listAgentRoles().map((role) => role.name);
    expect(names).toContain("default");
    expect(names).toContain("explorer");
    expect(names).toContain("worker");
    expect(names).toContain("verification");
    expect(names).not.toContain("awaiter");
  });

  it("explorer resolves through Codex-shaped config-file metadata", () => {
    const role = getAgentRole("explorer")!;
    expect(role.config.configFile).toBe("explorer.toml");
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.allowlist).toBeUndefined();
    expect(role.config.description).toContain(
      "Explorers are fast and authoritative",
    );
  });

  it("worker has the Codex description and no built-in config-layer override", () => {
    const role = resolveAgentRole("worker");
    expect(role.name).toBe("worker");
    expect(role.config.configFile).toBeUndefined();
    expect(role.config.reasoningEffort).toBeUndefined();
    expect(role.config.nicknameCandidates).toBeUndefined();
    expect(role.config.description).toContain(
      "Use for execution and production work",
    );
  });

  it("verification role carries the OpenClaude verifier prompt and safe allowlist", () => {
    const role = resolveAgentRole("verification");
    expect(role.name).toBe("verification");
    expect(role.config.background).toBe(true);
    expect(role.config.systemPrompt).toContain("VERDICT: PASS");
    expect(role.config.allowlist).toContain("Bash");
    expect(role.config.allowlist).not.toContain("Write");
    expect(role.config.description).toContain("verify that implementation work is correct");
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

  it("formatRoleList uses AgenC-style locked-setting notes from role TOML", () => {
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
