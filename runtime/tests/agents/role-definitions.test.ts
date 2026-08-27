import { describe, it, expect } from "vitest";

import {
  _resetAgentRolesForTesting,
  createAgentRoleWorkspace,
  listAgentRoles,
} from "./role.js";
import { listAgentRoleDefinitions } from "./role-definitions.js";

const DEFAULT_CWD = process.cwd();
const DEFAULT_WORKSPACE = createAgentRoleWorkspace(DEFAULT_CWD);

describe("listAgentRoleDefinitions (TUI agent picker wiring)", () => {
  it("returns one entry per registered agent role", () => {
    const roleCount = listAgentRoles(DEFAULT_WORKSPACE).length;
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    expect(list.length).toBe(roleCount);
    expect(list.length).toBeGreaterThan(0);
  });

  it("every entry is shaped as a BuiltInAgentDefinition", () => {
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    for (const def of list) {
      expect(typeof def.agentType).toBe("string");
      expect(def.agentType.length).toBeGreaterThan(0);
      expect(typeof def.whenToUse).toBe("string");
      expect(def.whenToUse.length).toBeGreaterThan(0);
      expect((def as { source: string }).source).toBe("built-in");
      expect((def as { baseDir: string }).baseDir).toBe("built-in");
      expect(typeof (def as { getSystemPrompt: () => string }).getSystemPrompt).toBe(
        "function",
      );
    }
  });

  it("agentType matches the AgentRole.name", () => {
    const roleNames = listAgentRoles(DEFAULT_WORKSPACE).map((r) => r.name);
    const got = listAgentRoleDefinitions(DEFAULT_CWD).map((d) => d.agentType);
    expect(got).toEqual(roleNames);
  });

  it("whenToUse falls back to role name when description is absent", () => {
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    const roles = listAgentRoles(DEFAULT_WORKSPACE);
    for (const role of roles) {
      const projected = list.find((d) => d.agentType === role.name);
      expect(projected).toBeDefined();
      const expected = role.config.description ?? role.name;
      expect(projected?.whenToUse).toBe(expected);
    }
  });

  it("tools are populated only when the role has an allowlist", () => {
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    const roles = listAgentRoles(DEFAULT_WORKSPACE);
    for (const role of roles) {
      const projected = list.find((d) => d.agentType === role.name);
      expect(projected).toBeDefined();
      if (role.config.allowlist && role.config.allowlist.length > 0) {
        expect(projected?.tools).toEqual([...role.config.allowlist]);
      } else {
        expect(projected?.tools).toBeUndefined();
      }
    }
  });

  it("preserves an empty allowlist as tools: [] — distinct from a missing allowlist (which omits the field)", async () => {
    const { registerAgentRole, _resetAgentRolesForTesting } = await import(
      "./role.js"
    );
    _resetAgentRolesForTesting();
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "empty-allowlist-role",
      config: {
        description: "role with explicit empty allowlist",
        allowlist: [],
      },
    });
    registerAgentRole(DEFAULT_WORKSPACE, {
      name: "no-allowlist-role",
      config: { description: "role with no allowlist at all" },
    });
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    const empty = list.find((d) => d.agentType === "empty-allowlist-role");
    const missing = list.find((d) => d.agentType === "no-allowlist-role");
    expect(empty?.tools).toEqual([]);
    expect(missing?.tools).toBeUndefined();
    _resetAgentRolesForTesting();
  });

  it("getSystemPrompt returns the role's systemPrompt or empty string", () => {
    const list = listAgentRoleDefinitions(DEFAULT_CWD);
    const roles = listAgentRoles(DEFAULT_WORKSPACE);
    for (const role of roles) {
      const projected = list.find((d) => d.agentType === role.name);
      expect(projected).toBeDefined();
      const expected = role.config.systemPrompt ?? "";
      const builtIn = projected as { getSystemPrompt: (params: unknown) => string };
      expect(builtIn.getSystemPrompt({ toolUseContext: { options: {} } })).toBe(
        expected,
      );
    }
  });

});
