import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRoleCatalog } from "./role-catalog.js";
import {
  _resetAgentRolesForTesting,
  agentRoleFingerprint,
  createAgentRoleWorkspace,
  listBuiltInAgentRoles,
  registerAgentRole,
} from "./role.js";
import {
  roleToAgentDefinition,
  type AgentDefinition,
} from "../tools/AgentTool/loadAgentsDir.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  _resetAgentRolesForTesting();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function builtIns(): AgentDefinition[] {
  return listBuiltInAgentRoles().map(roleToAgentDefinition);
}

function customDefinition(marker: string): AgentDefinition {
  return {
    agentType: "shared-reviewer",
    whenToUse: `Reviewer ${marker}`,
    source: "userSettings",
    baseDir: "workspace-role",
    effort: marker === "A" ? "low" : "high",
    roleDefinitionPrompt: `Prompt ${marker}`,
    getSystemPrompt: () => `Prompt ${marker}`,
  };
}

describe("AgentRoleCatalog", () => {
  it("keeps same-cwd A to B to A session snapshots isolated", () => {
    const workspace = createAgentRoleWorkspace(process.cwd());
    const catalogA = new AgentRoleCatalog(workspace, {
      agentRoleWorkspaceId: workspace.id,
      activeAgents: [...builtIns(), customDefinition("A")],
    });
    const catalogB = new AgentRoleCatalog(workspace, {
      agentRoleWorkspaceId: workspace.id,
      activeAgents: [...builtIns(), customDefinition("B")],
    });

    expect(catalogA.require("shared-reviewer").config.systemPrompt).toBe(
      "Prompt A",
    );
    expect(catalogB.require("shared-reviewer").config.systemPrompt).toBe(
      "Prompt B",
    );
    expect(catalogA.require("shared-reviewer").config.systemPrompt).toBe(
      "Prompt A",
    );
  });

  it("does not consult the ambient managed-agent environment", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-role-catalog-managed-"));
    temporaryRoots.push(root);
    const managed = join(root, "managed-agents");
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      join(managed, "injected.md"),
      [
        "---",
        "name: ambient-injected",
        "description: Must not load",
        "---",
        "Ambient prompt.",
      ].join("\n"),
    );
    vi.stubEnv("AGENC_MANAGED_AGENTS_DIR", managed);

    const workspace = createAgentRoleWorkspace(process.cwd());
    const catalog = new AgentRoleCatalog(workspace);

    expect(catalog.get("ambient-injected")).toBeUndefined();
    expect(catalog.require("default").source).toBe("built-in");
  });

  it("keeps plugin identity and executable policy in one frozen role", () => {
    const workspace = createAgentRoleWorkspace(process.cwd());
    const pluginDefinition: AgentDefinition = {
      agentType: "review-plugin:security",
      whenToUse: "Review security boundaries",
      source: "plugin",
      plugin: "review-plugin",
      baseDir: "/plugins/review-plugin/agents",
      tools: ["FileRead"],
      disallowedTools: ["Write"],
      effort: "xhigh",
      roleDefinitionPrompt: "Inspect trust boundaries.",
      getSystemPrompt: () => "Inspect trust boundaries.",
    };
    const catalog = new AgentRoleCatalog(workspace, {
      agentRoleWorkspaceId: workspace.id,
      activeAgents: [...builtIns(), pluginDefinition],
    });

    const role = catalog.require("review-plugin:security");
    expect(role).toMatchObject({
      name: "review-plugin:security",
      source: "plugin",
      config: {
        systemPrompt: "Inspect trust boundaries.",
        allowlist: ["FileRead"],
        disallowlist: ["Write"],
        reasoningEffort: "xhigh",
      },
    });
    expect(catalog.fingerprint(role)).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(role.config)).toBe(true);
  });

  it("preserves exact built-in and programmatic role-only policy", () => {
    const workspace = createAgentRoleWorkspace(process.cwd());
    registerAgentRole(workspace, {
      name: "registered-specialist",
      config: {
        description: "Registered specialist",
        systemPrompt: "Keep every registered field.",
        configFile: "scanner.toml",
        serviceTier: "priority",
        nicknameCandidates: ["ExactNickname"],
      },
    });
    const programmaticDefinition: AgentDefinition = {
      agentType: "registered-specialist",
      whenToUse: "Registered specialist",
      source: "flagSettings",
      baseDir: "programmatic",
      roleDefinitionPrompt: "Keep every registered field.",
      getSystemPrompt: () => "Keep every registered field.",
    };
    const catalog = new AgentRoleCatalog(workspace, {
      agentRoleWorkspaceId: workspace.id,
      activeAgents: [...builtIns(), programmaticDefinition],
    });

    const scanner = catalog.require("scanner");
    const registered = catalog.require("registered-specialist");
    expect(scanner.config.configFile).toBe("scanner.toml");
    expect(catalog.fingerprint(scanner)).toBe(agentRoleFingerprint(scanner));
    expect(registered.config).toMatchObject({
      configFile: "scanner.toml",
      serviceTier: "priority",
      nicknameCandidates: ["ExactNickname"],
    });
    expect(catalog.fingerprint(registered)).toBe(
      agentRoleFingerprint(registered),
    );
  });
});
