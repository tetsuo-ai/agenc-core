import { describe, expect, it } from "vitest";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../../src/permissions/evaluator.js";
import { freshDenialTracking } from "../../src/permissions/denial-tracking.js";
import {
  PermissionModeRegistry,
} from "../../src/permissions/permission-mode.js";
import { AGENC_MARKETPLACE_KIT_INSTALLER_SKILL } from "../../src/skills/bundled/agencMarketplaceKitInstaller.js";
import {
  MAX_SESSION_TOOL_POLICY_TOOLS,
  NEVER_ENABLED_BUNDLED_SKILLS,
  TOOL_POLICY_METADATA_KEY,
  TOOL_POLICY_MODE_CEILING_METADATA_KEY,
  isWiderPermissionMode,
  normalizeSessionToolPolicy,
  retainedToolPolicyModeCeiling,
  sameSessionToolPolicy,
  sessionToolPolicyAllowsBundledSkill,
  sessionToolPolicyAllowsProtocolCommands,
  sessionToolPolicyAllowsTool,
  sessionToolPolicyFromMetadata,
  sessionToolPolicyIssue,
  sessionToolPolicyNoFsWriteTools,
} from "../../src/permissions/session-tool-policy.js";
import {
  createEmptyToolPermissionContext,
  immutableToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import {
  applyUnattendedPermissionPolicyToContext,
  toolPolicyDenyDecision,
} from "../../src/permissions/unattended-policy.js";
import type { Session } from "../../src/session/session.js";

describe("sessionToolPolicyIssue", () => {
  it("accepts a minimal and a full policy", () => {
    expect(sessionToolPolicyIssue({ enabledTools: ["FileRead"] })).toBeUndefined();
    expect(
      sessionToolPolicyIssue({
        enabledTools: ["FileRead", "mcp.desktop.read_file", "mcp.plugin:srv.tool-1"],
        frozenPermissionMode: true,
        deferMcpTools: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    [undefined, "must be an object"],
    [[], "must be an object"],
    ["FileRead", "must be an object"],
    [{}, "enabledTools must be an array of strings"],
    [{ enabledTools: "FileRead" }, "enabledTools must be an array of strings"],
    [{ enabledTools: [] }, "enabledTools must not be empty"],
    [{ enabledTools: ["FileRead", 3] }, "enabledTools must be an array of strings"],
    [{ enabledTools: ["FileRead", "FileRead"] }, 'lists "FileRead" more than once'],
    [{ enabledTools: [""] }, "not a well-formed tool name"],
    [{ enabledTools: [" FileRead"] }, "not a well-formed tool name"],
    [{ enabledTools: ["File Read"] }, "not a well-formed tool name"],
    [{ enabledTools: [".hidden"] }, "not a well-formed tool name"],
    [{ enabledTools: ["a/b"] }, "not a well-formed tool name"],
    [{ enabledTools: ["tool\n"] }, "not a well-formed tool name"],
    [{ enabledTools: ["x".repeat(129)] }, "not a well-formed tool name"],
    [{ enabledTools: ["FileRead"], frozenPermissionMode: "yes" }, "frozenPermissionMode must be a boolean"],
    [{ enabledTools: ["FileRead"], deferMcpTools: 0 }, "deferMcpTools must be a boolean"],
    [{ enabledTools: ["FileRead"], extra: true }, "does not accept 'extra'"],
  ])("rejects %j", (value, fragment) => {
    expect(sessionToolPolicyIssue(value)).toContain(fragment);
  });

  describe("MCP tools that deferral would leave unreachable", () => {
    const SEARCH = "system.searchTools";

    it("rejects a policy that defers MCP tools without the search tool", () => {
      for (const policy of [
        { enabledTools: ["FileRead"], deferMcpTools: true },
        // Deferral is the default, so naming an MCP tool defers it.
        { enabledTools: ["FileRead", "mcp.desktop.read_file"] },
        { enabledTools: ["mcp.desktop.read_file"], deferMcpTools: true },
      ]) {
        const issue = sessionToolPolicyIssue(policy);
        expect(issue, JSON.stringify(policy)).toContain(`must include "${SEARCH}"`);
        expect(issue).toContain("deferMcpTools");
        expect(() => normalizeSessionToolPolicy(policy)).toThrow(/invalid toolPolicy/);
      }
    });

    it("accepts the search tool, direct MCP tools, and policies with no MCP tools", () => {
      for (const policy of [
        { enabledTools: ["FileRead", "mcp.desktop.read_file", SEARCH] },
        { enabledTools: ["FileRead", SEARCH], deferMcpTools: true },
        { enabledTools: ["FileRead", "mcp.desktop.read_file"], deferMcpTools: false },
        // Nothing MCP-shaped is named and deferral is left at its default.
        { enabledTools: ["FileRead"] },
        { enabledTools: ["FileRead"], deferMcpTools: false },
      ]) {
        expect(sessionToolPolicyIssue(policy), JSON.stringify(policy)).toBeUndefined();
      }
    });

    it("refuses a stored policy that violates it, so a restore cannot lose the check", () => {
      expect(() =>
        sessionToolPolicyFromMetadata({
          [TOOL_POLICY_METADATA_KEY]: { enabledTools: ["mcp.desktop.read_file"] },
        }),
      ).toThrow(/system\.searchTools/);
    });
  });

  describe("bundled skill entries", () => {
    it("accepts Skill:<name> beside the Skill tool", () => {
      expect(
        sessionToolPolicyIssue({ enabledTools: ["Skill", "Skill:browser-automation"] }),
      ).toBeUndefined();
    });

    it("rejects an entry without the Skill tool, an empty one, and the kit installer", () => {
      expect(sessionToolPolicyIssue({ enabledTools: ["FileRead", "Skill:browser-automation"] }))
        .toContain('but not "Skill"');
      expect(sessionToolPolicyIssue({ enabledTools: ["Skill", "Skill:"] })).toContain("names no skill");
      expect(
        sessionToolPolicyIssue({
          enabledTools: ["Skill", "Skill:agenc-marketplace-kit-installer"],
        }),
      ).toContain("can never be enabled");
    });
  });

  it("caps the number of tools", () => {
    const tooMany = Array.from({ length: MAX_SESSION_TOOL_POLICY_TOOLS + 1 }, (_, i) => `tool${i}`);
    expect(sessionToolPolicyIssue({ enabledTools: tooMany })).toContain("at most");
    expect(sessionToolPolicyIssue({ enabledTools: tooMany.slice(0, -1) })).toBeUndefined();
  });
});

describe("noFsWriteTools", () => {
  const enabledTools = ["system.searchTools", "mcp.task.view_task", "mcp.task.run_tests", "FileRead"];

  it("accepts MCP tools that are also enabled, and hands each server only its own", () => {
    const policy = normalizeSessionToolPolicy({ enabledTools, noFsWriteTools: ["mcp.task.view_task", "mcp.task.run_tests"] });
    expect(Object.isFrozen(policy.noFsWriteTools)).toBe(true);
    expect(sessionToolPolicyNoFsWriteTools(policy, "task")).toEqual(["view_task", "run_tests"]);
    expect(sessionToolPolicyNoFsWriteTools(policy, "other")).toBeUndefined();
    expect(sessionToolPolicyNoFsWriteTools(normalizeSessionToolPolicy({ enabledTools }), "task")).toBeUndefined();
  });

  it("refuses names that are not enabled MCP tools, and duplicates", () => {
    expect(sessionToolPolicyIssue({ enabledTools, noFsWriteTools: ["mcp.task.claim_task"] })).toMatch(/not in enabledTools/);
    expect(sessionToolPolicyIssue({ enabledTools, noFsWriteTools: ["FileRead"] })).toMatch(/not an MCP tool name/);
    expect(sessionToolPolicyIssue({ enabledTools, noFsWriteTools: ["mcp.task"] })).toMatch(/not an MCP tool name/);
    expect(sessionToolPolicyIssue({ enabledTools, noFsWriteTools: ["mcp.task.view_task", "mcp.task.view_task"] })).toMatch(/more than once/);
    expect(sessionToolPolicyIssue({ enabledTools, noFsWriteTools: "mcp.task.view_task" })).toMatch(/array of strings/);
  });

  it("counts toward whether a restored session keeps the same policy", () => {
    const granted = normalizeSessionToolPolicy({ enabledTools, noFsWriteTools: ["mcp.task.view_task"] });
    const plain = normalizeSessionToolPolicy({ enabledTools });
    expect(sameSessionToolPolicy(granted, plain)).toBe(false);
    expect(sameSessionToolPolicy(granted, normalizeSessionToolPolicy({ enabledTools: [...enabledTools].reverse(), noFsWriteTools: ["mcp.task.view_task"] }))).toBe(true);
  });

  it("accepts plugin-scoped MCP names and restores the grant from metadata", () => {
    const policy = {
      enabledTools: ["system.searchTools", "mcp.plugin:srv.tool-1", "FileRead"],
      noFsWriteTools: ["mcp.plugin:srv.tool-1"],
    };
    expect(sessionToolPolicyIssue(policy)).toBeUndefined();
    const normalized = normalizeSessionToolPolicy(policy);
    expect(sessionToolPolicyNoFsWriteTools(normalized, "plugin:srv")).toEqual(["tool-1"]);
    expect(sessionToolPolicyNoFsWriteTools(normalized, "plugin")).toBeUndefined();
    expect(
      sessionToolPolicyFromMetadata({ [TOOL_POLICY_METADATA_KEY]: policy }),
    ).toEqual(normalized);
    expect(
      sameSessionToolPolicy(
        normalized,
        sessionToolPolicyFromMetadata({ [TOOL_POLICY_METADATA_KEY]: policy })!,
      ),
    ).toBe(true);
  });
});

describe("toolPolicyDenyDecision", () => {
  it("is a bypass-immune deny with a stable audit reason", () => {
    expect(toolPolicyDenyDecision("system.bash")).toEqual({
      behavior: "deny",
      message: "Permission to use system.bash was denied: it is not enabled for this session.",
      decisionReason: {
        type: "other",
        reason: "session tool policy: system.bash is not enabled",
      },
    });
  });
});

describe("normalizeSessionToolPolicy and metadata", () => {
  it("returns a frozen copy that omits unset flags", () => {
    const input = { enabledTools: ["FileRead"] };
    const policy = normalizeSessionToolPolicy(input);
    expect(policy).toEqual({ enabledTools: ["FileRead"] });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.enabledTools)).toBe(true);
    expect(policy.enabledTools).not.toBe(input.enabledTools);
    expect(() => normalizeSessionToolPolicy({ enabledTools: [] })).toThrow(/invalid toolPolicy/);
  });

  it("reads the stored policy back, and fails closed on a malformed one", () => {
    expect(sessionToolPolicyFromMetadata(undefined)).toBeUndefined();
    expect(sessionToolPolicyFromMetadata({})).toBeUndefined();
    expect(
      sessionToolPolicyFromMetadata({
        [TOOL_POLICY_METADATA_KEY]: { enabledTools: ["FileRead"], frozenPermissionMode: true },
      }),
    ).toEqual({ enabledTools: ["FileRead"], frozenPermissionMode: true });
    // Dropping a corrupt policy would silently widen a restored session.
    expect(() =>
      sessionToolPolicyFromMetadata({ [TOOL_POLICY_METADATA_KEY]: { enabledTools: [] } }),
    ).toThrow(/invalid toolPolicy/);
    expect(() => sessionToolPolicyFromMetadata({ [TOOL_POLICY_METADATA_KEY]: "FileRead" })).toThrow();
  });

  it("reads the recorded mode ceiling and rejects an unknown one", () => {
    expect(retainedToolPolicyModeCeiling(undefined)).toBeUndefined();
    expect(retainedToolPolicyModeCeiling({ [TOOL_POLICY_MODE_CEILING_METADATA_KEY]: "acceptEdits" }))
      .toBe("acceptEdits");
    expect(() => retainedToolPolicyModeCeiling({ [TOOL_POLICY_MODE_CEILING_METADATA_KEY]: "root" }))
      .toThrow(/ceiling/);
  });

  it("allows only listed names, and everything without a policy", () => {
    const policy = normalizeSessionToolPolicy({ enabledTools: ["FileRead"] });
    expect(sessionToolPolicyAllowsTool(policy, "FileRead")).toBe(true);
    expect(sessionToolPolicyAllowsTool(policy, "fileread")).toBe(false);
    expect(sessionToolPolicyAllowsTool(policy, "system.bash")).toBe(false);
    expect(sessionToolPolicyAllowsTool(undefined, "system.bash")).toBe(true);
  });

  it("offers a bundled skill to a policy session only when it names it beside the Skill tool", () => {
    const named = normalizeSessionToolPolicy({ enabledTools: ["Skill", "Skill:browser-automation"] });
    expect(sessionToolPolicyAllowsBundledSkill(named, "browser-automation")).toBe(true);
    expect(sessionToolPolicyAllowsBundledSkill(named, "other-skill")).toBe(false);
    // The Skill tool alone enables no bundled skill.
    const toolOnly = normalizeSessionToolPolicy({ enabledTools: ["Skill"] });
    expect(sessionToolPolicyAllowsBundledSkill(toolOnly, "browser-automation")).toBe(false);
    // A named skill needs the tool too, even for a policy built without validation.
    const noTool = { enabledTools: ["Skill:browser-automation"] };
    expect(sessionToolPolicyAllowsBundledSkill(noTool, "browser-automation")).toBe(false);
    // Without a policy nothing changes.
    expect(sessionToolPolicyAllowsBundledSkill(undefined, "browser-automation")).toBe(true);
    expect(sessionToolPolicyAllowsBundledSkill(undefined, "agenc-marketplace-kit-installer")).toBe(true);
  });

  it("never offers the kit installer to a policy session, even when named", () => {
    expect(NEVER_ENABLED_BUNDLED_SKILLS).toContain(AGENC_MARKETPLACE_KIT_INSTALLER_SKILL.name);
    const forced = {
      enabledTools: ["Skill", `Skill:${AGENC_MARKETPLACE_KIT_INSTALLER_SKILL.name}`],
    };
    expect(sessionToolPolicyAllowsBundledSkill(forced, AGENC_MARKETPLACE_KIT_INSTALLER_SKILL.name))
      .toBe(false);
  });

  it("allows the protocol commands only without a policy", () => {
    expect(sessionToolPolicyAllowsProtocolCommands(undefined)).toBe(true);
    expect(sessionToolPolicyAllowsProtocolCommands(normalizeSessionToolPolicy({ enabledTools: ["FileRead"] })))
      .toBe(false);
  });

  it("compares policies by authority, not by order", () => {
    const a = normalizeSessionToolPolicy({ enabledTools: ["A", "B"], frozenPermissionMode: true });
    expect(sameSessionToolPolicy(a, normalizeSessionToolPolicy({ enabledTools: ["B", "A"], frozenPermissionMode: true })))
      .toBe(true);
    expect(sameSessionToolPolicy(a, normalizeSessionToolPolicy({ enabledTools: ["A", "B"] }))).toBe(false);
    expect(sameSessionToolPolicy(a, normalizeSessionToolPolicy({ enabledTools: ["A"], frozenPermissionMode: true })))
      .toBe(false);
  });
});

describe("permission mode ranking", () => {
  it("orders plan below default below acceptEdits below bypass", () => {
    const widerThan = (target: PermissionMode, ceiling: PermissionMode) => isWiderPermissionMode(target, ceiling);
    expect(widerThan("bypassPermissions", "default")).toBe(true);
    expect(widerThan("acceptEdits", "default")).toBe(true);
    expect(widerThan("auto", "acceptEdits")).toBe(true);
    expect(widerThan("default", "default")).toBe(false);
    expect(widerThan("plan", "default")).toBe(false);
    expect(widerThan("dontAsk", "default")).toBe(false);
    expect(widerThan("default", "plan")).toBe(true);
    expect(widerThan("default", "unattended")).toBe(false);
    expect(widerThan("acceptEdits", "unattended")).toBe(true);
  });
});

describe("the tool allowlist on the bypass-immune permission floor", () => {
  function contextFor(mode: PermissionMode, enabledTools: readonly string[] | undefined): ToolEvaluatorContext {
    const ctx: ToolPermissionContext = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext({ mode }),
      enabledTools === undefined ? {} : { enabledTools },
    );
    const state: AppStateSnapshot = {
      toolPermissionContext: ctx,
      denialTracking: freshDenialTracking(),
      autoModeActive: false,
    };
    return attachContextDefaults({
      getAppState: (): AppStateSnapshot => state,
      session: { state: { unsafePeek: () => ({ history: [] }) } } as unknown as Session,
    } as ToolEvaluatorContext);
  }

  it.each(["bypassPermissions", "default", "acceptEdits", "unattended"] as const)(
    "denies a tool outside enabledTools in %s mode",
    async (mode) => {
      const context = contextFor(mode, ["FileRead"]);
      const result = await hasPermissionsToUseTool({ name: "system.bash" }, { command: "ls" }, context);
      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.decisionReason).toMatchObject({
          type: "other",
          reason: "session tool policy: system.bash is not enabled",
        });
      }
    },
  );

  it("keeps a listed tool on its normal path", async () => {
    const context = contextFor("bypassPermissions", ["FileRead"]);
    const result = await hasPermissionsToUseTool({ name: "FileRead", isReadOnly: true }, { path: "a" }, context);
    expect(result.behavior).toBe("allow");
  });

  it("matches exact names, not risk families", async () => {
    // exec_command shares the system.bash risk family; listing one must not list the other.
    const context = contextFor("bypassPermissions", ["exec_command"]);
    expect((await hasPermissionsToUseTool({ name: "exec_command" }, { cmd: "ls" }, context)).behavior).toBe("allow");
    expect((await hasPermissionsToUseTool({ name: "system.bash" }, { command: "ls" }, context)).behavior).toBe("deny");
    expect((await hasPermissionsToUseTool({ name: "write_stdin" }, {}, context)).behavior).toBe("deny");
  });

  it("changes nothing without enabledTools", async () => {
    const context = contextFor("bypassPermissions", undefined);
    const result = await hasPermissionsToUseTool({ name: "system.bash" }, { command: "ls" }, context);
    expect(result.behavior).toBe("allow");
  });

  it("survives the registry's immutable snapshot", () => {
    const ctx = applyUnattendedPermissionPolicyToContext(
      createEmptyToolPermissionContext({ mode: "default" }),
      { enabledTools: ["FileRead"] },
    );
    const cloned = immutableToolPermissionContext(ctx, { forceClone: true });
    expect(cloned.unattendedPolicy?.enabledTools).toEqual(["FileRead"]);
    expect(cloned.unattendedPolicy?.enabledTools).not.toBe(ctx.unattendedPolicy?.enabledTools);
  });
});

describe("PermissionModeRegistry mode ceiling", () => {
  const at = (mode: PermissionMode) => createEmptyToolPermissionContext({ mode });

  it("refuses every publication path that would widen the mode", async () => {
    const registry = new PermissionModeRegistry(at("default"));
    registry.freezeModeCeiling("default");
    await expect(registry.update(at("bypassPermissions"))).rejects.toThrow(/frozen by this session's toolPolicy/);
    await expect(
      registry.transact(() => ({ next: at("acceptEdits"), result: () => "wide" })),
    ).rejects.toThrow(/frozen/);
    expect(registry.current().mode).toBe("default");
  });

  it("allows narrowing and a return to the ceiling, never past it", async () => {
    const registry = new PermissionModeRegistry(at("acceptEdits"));
    registry.freezeModeCeiling("acceptEdits");
    await registry.update(at("plan"));
    expect(registry.current().mode).toBe("plan");
    await registry.update(at("acceptEdits"));
    expect(registry.current().mode).toBe("acceptEdits");
    await expect(registry.update(at("bypassPermissions"))).rejects.toThrow(/frozen/);
  });

  it("cannot be raised once set, and is absent by default", () => {
    const registry = new PermissionModeRegistry(at("default"));
    expect(registry.modeCeiling).toBeUndefined();
    registry.freezeModeCeiling("default");
    expect(() => registry.freezeModeCeiling("bypassPermissions")).toThrow(/cannot be raised/);
    registry.freezeModeCeiling("plan");
    expect(registry.modeCeiling).toBe("plan");
  });

  it("changes nothing for a registry without a ceiling", async () => {
    const registry = new PermissionModeRegistry(at("default"));
    await registry.update(at("bypassPermissions"));
    expect(registry.current().mode).toBe("bypassPermissions");
  });
});
