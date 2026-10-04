import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ConfigStore } from "../../src/config/store.js";
import type { Session } from "../../src/session/session.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

const evaluations = vi.hoisted(() => ({
  config: 0, diff: 0, model: 0, plan: 0, provider: 0, status: 0,
  hooks: 0, mcp: 0, outputStyle: 0, permissions: 0, resume: 0, compact: 0, skills: 0,
  auth: 0, xaiAuth: 0, openaiAuth: 0, plugins: 0, remote: 0, agents: 0,
}));

// Count evaluation while preserving the real implementations and their graph.
vi.mock("../../src/commands/config-menu.js", async (original) => {
  evaluations.config++;
  return original();
});
vi.mock("../../src/commands/diff-menu.js", async (original) => {
  evaluations.diff++;
  return original();
});
vi.mock("../../src/commands/model-menu.js", async (original) => {
  evaluations.model++;
  return original();
});
vi.mock("../../src/commands/plan-menu.js", async (original) => {
  evaluations.plan++;
  return original();
});
vi.mock("../../src/commands/provider-menu.js", async (original) => {
  evaluations.provider++;
  return original();
});
vi.mock("../../src/commands/status-menu.js", async (original) => {
  evaluations.status++;
  return original();
});
vi.mock("../../src/commands/hooks-menu.js", async (original) => {
  evaluations.hooks++;
  return original();
});
vi.mock("../../src/commands/mcp-menu.js", async (original) => {
  evaluations.mcp++;
  return original();
});
vi.mock("../../src/commands/output-style-menu.js", async (original) => {
  evaluations.outputStyle++;
  return original();
});
vi.mock("../../src/commands/permissions-menu.js", async (original) => {
  evaluations.permissions++;
  return original();
});
vi.mock("../../src/commands/resume-menu.js", async (original) => {
  evaluations.resume++;
  return original();
});
vi.mock("../../src/commands/compact-menu.js", async (original) => {
  evaluations.compact++;
  return original();
});
vi.mock("../../src/commands/skills-menu.js", async (original) => {
  evaluations.skills++;
  return original();
});

vi.mock("../../src/commands/auth-menu.js", async (original) => {
  evaluations.auth++;
  return original();
});
vi.mock("../../src/commands/xai-auth-menu.js", async (original) => {
  evaluations.xaiAuth++;
  return original();
});
vi.mock("../../src/commands/openai-auth-menu.js", async (original) => {
  evaluations.openaiAuth++;
  return original();
});
vi.mock("../../src/commands/plugins-menu.js", async (original) => {
  evaluations.plugins++;
  return original();
});
vi.mock("../../src/commands/remote-menu.js", async (original) => {
  evaluations.remote++;
  return original();
});
vi.mock("../../src/commands/agents-menu.js", async (original) => {
  evaluations.agents++;
  return original();
});

let coldEvaluations: typeof evaluations;
let config: typeof import("../../src/commands/config.js");

beforeAll(async () => {
  [config] = await Promise.all([
    import("../../src/commands/config.js"),
    import("../../src/commands/diff.js"),
    import("../../src/commands/model.js"),
    import("../../src/commands/plan.js"),
    import("../../src/commands/provider.js"),
    import("../../src/commands/status.js"),
    import("../../src/commands/hooks.js"),
    import("../../src/commands/mcp.js"),
    import("../../src/commands/output-style.js"),
    import("../../src/commands/permissions.js"),
    import("../../src/commands/resume.js"),
    import("../../src/commands/session-compact.js"),
    import("../../src/commands/skills.js"),
    import("../../src/commands/registry.js"),
    import("../../src/bin/agenc-main.js"),
  ]);
  coldEvaluations = { ...evaluations };
}, 30_000);

describe("deferred command presentation", () => {
  it("makes commands and daemon helpers available without evaluating menus", () => {
    expect(coldEvaluations).toEqual({
      config: 0, diff: 0, model: 0, plan: 0, provider: 0, status: 0,
      hooks: 0, mcp: 0, outputStyle: 0, permissions: 0, resume: 0, compact: 0, skills: 0,
      auth: 0, xaiAuth: 0, openaiAuth: 0, plugins: 0, remote: 0, agents: 0,
    });
  });

  it("preserves config text commands and keeps its noninteractive fallback renderer-free", async () => {
    const snapshot = { model: "test-model" };
    const ctx: SlashCommandContext = {
      session: { services: {} } as unknown as Session,
      configStore: { current: () => snapshot } as unknown as ConfigStore,
      argsRaw: "show",
      cwd: "/repo",
      home: "/home/test",
    };
    const expected = { kind: "text", text: JSON.stringify(snapshot, null, 2) };
    expect(await config.configCommand.execute(ctx)).toEqual(expected);
    expect(evaluations.config).toBe(0);
    expect(await config.configCommand.execute({ ...ctx, argsRaw: "" })).toEqual(expected);
    expect(evaluations.config).toBe(0);
  });

  it("keeps hooks, MCP, skills and resume text fallbacks renderer-free", async () => {
    const [hooks, mcp, skills, resume] = await Promise.all([
      import("../../src/commands/hooks.js"),
      import("../../src/commands/mcp.js"),
      import("../../src/commands/skills.js"),
      import("../../src/commands/resume.js"),
    ]);
    const ctx: SlashCommandContext = {
      session: {
        config: {},
        services: {
          mcpManager: { effectiveServers: async () => new Map() },
          skillsManager: {
            skillsForConfig: async () => ({ invokedSkills: [], availableSkills: [] }),
          },
          pluginsManager: {
            pluginsForConfig: async () => ({ effectiveSkillRoots: () => [] }),
          },
        },
      } as unknown as Session,
      argsRaw: "",
      cwd: "/nonexistent-presentation-test/project",
      home: "/nonexistent-presentation-test/home",
      agencHome: "/nonexistent-presentation-test/agenc",
    };
    expect(await hooks.default.execute(ctx)).toEqual({
      kind: "error", message: "Hooks runtime is not available in this session.",
    });
    expect(await mcp.mcpCommand.execute(ctx)).toMatchObject({ kind: "text" });
    expect(await skills.skillsCommand.execute(ctx)).toMatchObject({ kind: "text" });
    const directory = mkdtempSync(join(tmpdir(), "deferred-presentation-"));
    try {
      expect(await resume.resumeCommand.execute({
        ...ctx, cwd: directory, home: directory, agencHome: join(directory, ".agenc"),
      })).toMatchObject({ kind: "text" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(evaluations).toMatchObject({ hooks: 0, mcp: 0, skills: 0, resume: 0 });
  });

  it("preserves snapshot and text-formatter bindings for existing menu importers", async () => {
    const [diffMenu, diffSnapshot, statusMenu, statusSnapshot, modelMenu, modelSnapshot,
      providerMenu, providerSnapshot] = await Promise.all([
      import("../../src/commands/diff-menu.js"),
      import("../../src/commands/diff-menu-snapshot.js"),
      import("../../src/commands/status-menu.js"),
      import("../../src/commands/status-menu-snapshot.js"),
      import("../../src/commands/model-menu.js"),
      import("../../src/commands/model-menu-snapshot.js"),
      import("../../src/commands/provider-menu.js"),
      import("../../src/commands/provider-menu-snapshot.js"),
    ]);
    expect(diffMenu.createDiffMenuSnapshot).toBe(diffSnapshot.createDiffMenuSnapshot);
    expect(statusMenu.createStatusDashboardSnapshot).toBe(statusSnapshot.createStatusDashboardSnapshot);
    expect(modelMenu.readModelMenuSnapshot).toBe(modelSnapshot.readModelMenuSnapshot);
    expect(modelMenu.modelMenuFallback).toBe(modelSnapshot.modelMenuFallback);
    expect(providerMenu.readProviderMenuSnapshot).toBe(providerSnapshot.readProviderMenuSnapshot);
    expect(providerMenu.providerMenuFallback).toBe(providerSnapshot.providerMenuFallback);
  });
});
