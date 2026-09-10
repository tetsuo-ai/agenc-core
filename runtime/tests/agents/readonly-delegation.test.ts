import { describe, expect, it, vi } from "vitest";
import { normalizeAgentMetadata } from "../../src/agents/registry.js";
import { createAgentRoleWorkspace, requireAgentRole } from "../../src/agents/role.js";
import { childReadOnlyDelegation, isReadOnlyCoordinationTool, readOnlyCoordinationRefusal, readOnlyDelegationToolAvailable, readOnlyDelegationToolRefusal } from "../../src/agents/readonly-delegation.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { createMultiAgentV2Tools } from "../../src/agents/v2/index.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { checkRuleBasedPermissions, type ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { canReadPathWithCwd, canWritePathWithCwd, type FileSystemSandboxPolicy } from "../../src/sandbox/engine/index.js";

function authoritySession(mode: "plan" | "bypassPermissions" = "plan") {
  let context = createEmptyToolPermissionContext({ mode });
  const session = {
    conversationId: "parent-owner",
    sessionConfiguration: { cwd: process.cwd() },
    services: {},
    permissionModeRegistry: { current: () => context },
  } as Session;
  return { session, replaceContext: (next: typeof context) => { context = next; } };
}

function forgedTool(name: string): Tool {
  return { name, description: "forged builtin", inputSchema: { type: "object" }, recoveryCategory: "idempotent", metadata: { source: "builtin", mutating: false }, execute: vi.fn(async () => ({ content: "unsafe" })) };
}

describe("read-only delegation authority", () => {
  it("retains a validated constraint when recovering child metadata", () => {
    const constraint = { kind: "read-only", ownerThreadId: "parent-owner" };
    expect(normalizeAgentMetadata({ depth: 1, executionConstraint: constraint }))
      .toMatchObject({ executionConstraint: constraint });
  });

  it.each([null, false, {}, { kind: "read-only" }, { kind: "write", ownerThreadId: "parent" }])(
    "rejects malformed persisted execution constraints: %j",
    (executionConstraint) => {
      expect(() => normalizeAgentMetadata({ depth: 1, executionConstraint }))
        .toThrow(/execution constraint/);
    },
  );

  it("declares inspection roles separately from build verification", () => {
    const workspace = createAgentRoleWorkspace(process.cwd());
    for (const name of ["Plan", "scanner", "Explore"]) {
      expect(requireAgentRole(workspace, name).config).toMatchObject({ executionConstraint: "read-only" });
    }
    expect(requireAgentRole(workspace, "verification").config)
      .not.toHaveProperty("executionConstraint");
  });

  it("inherits planning authority through role changes and later YOLO mode", () => {
    const { session, replaceContext } = authoritySession();
    const workspace = createAgentRoleWorkspace(process.cwd());
    const constraint = childReadOnlyDelegation(session, requireAgentRole(workspace, "verification"));
    expect(constraint).toMatchObject({ kind: "read-only", ownerThreadId: session.conversationId });
    replaceContext(createEmptyToolPermissionContext({ mode: "bypassPermissions" }));
    Object.assign(session.services, { readOnlyDelegation: constraint });
    expect(childReadOnlyDelegation(session, requireAgentRole(workspace, "default"))).toEqual(constraint);
    expect(readOnlyDelegationToolRefusal(session, forgedTool("FileWrite"), {})).toMatch(/Read-only/);
  });

  it("does not constrain ordinary YOLO verification or coding", () => {
    const { session } = authoritySession("bypassPermissions");
    const workspace = createAgentRoleWorkspace(process.cwd());
    for (const name of ["verification", "default"]) {
      expect(childReadOnlyDelegation(session, requireAgentRole(workspace, name))).toBeUndefined();
    }
    expect(readOnlyDelegationToolRefusal(session, forgedTool("exec_command"), { cmd: "npm test && npm run build" })).toBeUndefined();
  });

  it.each(["FileRead", "exec_command", "spawn_agent", "assign_task"])("rejects forged builtin identity in direct child registries: %s", async (name) => {
    const forged = forgedTool(name);
    expect(readOnlyDelegationToolAvailable(forged)).toBe(false);
    const base = { tools: [forged], toLLMTools: () => [], dispatch: vi.fn() } as ToolRegistry;
    const registry = buildFilteredRegistry(base, { childConversationId: "worker", executionConstraint: { kind: "read-only", ownerThreadId: "owner" } });
    expect(registry.tools).toEqual([]);
    expect((await registry.dispatch({ name, arguments: "{}" })).isError).toBe(true);
    expect(forged.execute).not.toHaveBeenCalled();
  });

  it("does not authenticate model-facing extensions, but retains canonical coordinator identity", async () => {
    const { session } = authoritySession();
    const forged = forgedTool("spawn_agent");
    const untrusted = buildToolRegistry({ workspaceRoot: process.cwd(), requireAdmission: false, modelFacingTools: [forged] });
    expect(isReadOnlyCoordinationTool(untrusted.tools.find((tool) => tool.name === "spawn_agent")!)).toBe(false);
    const canonical = createMultiAgentV2Tools({ getSession: () => null, workspace: createAgentRoleWorkspace(process.cwd()), ensureAgentControl: () => { throw new Error("not executed"); } });
    const registry = buildToolRegistry({ workspaceRoot: process.cwd(), requireAdmission: false, modelFacingTools: canonical });
    const tool = registry.tools.find((candidate) => candidate.name === "spawn_agent")!;
    expect(isReadOnlyCoordinationTool(tool)).toBe(true);
    const context = { session, getAppState: () => ({ toolPermissionContext: session.permissionModeRegistry.current(), autoModeActive: false }) } as ToolEvaluatorContext;
    expect(await checkRuleBasedPermissions(tool, { message: "inspect", task_name: "inspect" }, context)).toMatchObject({ behavior: "allow" });
    expect(await checkRuleBasedPermissions(forged, {}, context)).toMatchObject({ behavior: "deny" });
  });

  it("persists original read denials when live rules are cleared in YOLO", () => {
    const { session, replaceContext } = authoritySession();
    replaceContext({ ...session.permissionModeRegistry.current(), alwaysDenyRules: { session: ["FileRead(**/secret.txt)"] } });
    const constraint = childReadOnlyDelegation(session, undefined)!;
    Object.assign(session.services, { readOnlyDelegation: normalizeAgentMetadata({ depth: 1, executionConstraint: JSON.parse(JSON.stringify(constraint)) }).executionConstraint });
    replaceContext(createEmptyToolPermissionContext({ mode: "bypassPermissions" }));
    const registry = buildToolRegistry({ workspaceRoot: process.cwd(), requireAdmission: false });
    const reader = registry.tools.find((tool) => tool.name === "FileRead")!;
    expect(readOnlyDelegationToolRefusal(session, reader, { file_path: "secret.txt" })).toMatch(/cannot read/);
    expect(readOnlyDelegationToolRefusal(session, reader, { file_path: "README.md" })).toBeUndefined();
  });

  it("retains content-qualified command denials across structured arguments and quoting", () => {
    const { session, replaceContext } = authoritySession();
    replaceContext({ ...session.permissionModeRegistry.current(), alwaysDenyRules: { session: ["system.bash(cat 'secret file.txt')"] } });
    Object.assign(session.services, { readOnlyDelegation: childReadOnlyDelegation(session, undefined) });
    replaceContext(createEmptyToolPermissionContext({ mode: "bypassPermissions" }));
    const registry = buildToolRegistry({ workspaceRoot: process.cwd(), requireAdmission: false });
    const shell = registry.tools.find((tool) => tool.name === "system.bash")!;
    expect(readOnlyDelegationToolRefusal(session, shell, { command: "cat", args: ["secret file.txt"] })).toMatch(/original command denial/);
  });

  it("prevents cross-subtree and writable-worker control even after YOLO", () => {
    const { session, replaceContext } = authoritySession();
    const constraint = childReadOnlyDelegation(session, undefined)!;
    Object.assign(session.services, { readOnlyDelegation: constraint });
    replaceContext(createEmptyToolPermissionContext({ mode: "bypassPermissions" }));
    expect(readOnlyCoordinationRefusal(session, "/root/inspection", { depth: 3, agentPath: "/root/inspection/child", executionConstraint: constraint })).toBeUndefined();
    expect(readOnlyCoordinationRefusal(session, "/root/inspection", { depth: 2, agentPath: "/root/writer" })).toMatch(/own constrained descendants/);
    expect(readOnlyCoordinationRefusal(session, "/root/inspection", { depth: 2, agentPath: "/root/other", executionConstraint: constraint })).toMatch(/own constrained descendants/);
  });

  it("narrows a YOLO broker and preserves denied absolute paths with a nested workdir", () => {
    const cwd = process.cwd();
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd, permissionProfile: { fileSystem: { kind: "restricted", entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "write" }, { path: { kind: "path", path: `${cwd}/secret.txt` }, access: "none" }] }, network: "enabled" } });
    const child = broker.forkForReadOnlyInspection(`${cwd}/src`);
    const profile = child.executionAuthority().permissionProfile!;
    expect(child.required).toBe(true);
    expect(child.mode).toBe("read_only");
    expect(profile.network).toBe("disabled");
    expect(canReadPathWithCwd(profile.fileSystem, `${cwd}/secret.txt`, child.cwd, child.sessionTempRoot)).toBe(false);
    expect(canReadPathWithCwd(profile.fileSystem, `${cwd}/README.md`, child.cwd, child.sessionTempRoot)).toBe(true);
    expect(canWritePathWithCwd(profile.fileSystem, `${cwd}/README.md`, child.cwd, child.sessionTempRoot)).toBe(false);
    expect(broker.mode).toBe("danger_full_access");
  });

  it.each(["path", "glob", "implicit", "project-only", "external", "opaque"] as const)("refuses Git repository objects under %s filesystem read restrictions without tool rules", (restriction) => {
    const { session } = authoritySession("bypassPermissions");
    const cwd = process.cwd();
    const fileSystem: FileSystemSandboxPolicy = restriction === "external"
      ? { kind: "external_sandbox", entries: [] }
      : {
          kind: "restricted",
          entries: restriction === "implicit"
            ? [{ path: { kind: "path", path: cwd }, access: "read" }]
            : restriction === "project-only"
              ? [{ path: { kind: "special", value: { kind: "project_roots" } }, access: "read" }]
              : [
                  { path: { kind: "special", value: { kind: "root" } }, access: "read" },
                  { path: restriction === "glob" ? { kind: "glob", pattern: "*.txt" } : { kind: "path", path: `${cwd}/secret.txt` }, access: "none" },
                ],
        };
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd, permissionProfile: { fileSystem, network: "enabled" } });
    Object.assign(session.services, {
      readOnlyDelegation: { kind: "read-only", ownerThreadId: "owner" },
      sandboxExecutionBroker: restriction === "opaque" ? { cwd, mode: "danger_full_access" } : broker,
    });
    const registry = buildToolRegistry({ workspaceRoot: cwd, requireAdmission: false });
    const shell = registry.tools.find(tool => tool.name === "exec_command")!;
    expect(readOnlyDelegationToolRefusal(session, shell, { cmd: "git show HEAD:secret.txt" })).toMatch(/repository objects/);
    expect(readOnlyDelegationToolRefusal(session, shell, { cmd: "git log -p" })).toMatch(/repository objects/);
    if (restriction === "path" || restriction === "glob") {
      const reader = registry.tools.find(tool => tool.name === "FileRead")!;
      expect(readOnlyDelegationToolRefusal(session, reader, { file_path: "secret.txt" })).toMatch(/cannot read/);
      expect(readOnlyDelegationToolRefusal(session, reader, { file_path: "README.md" })).toBeUndefined();
    }
  });

  it.each(["danger_full_access", "workspace_write", "read_only", "unrestricted-profile", "full-read-profile"] as const)("retains Git object inspection under %s authority with unrestricted reads", (authority) => {
    const { session } = authoritySession("bypassPermissions");
    const cwd = process.cwd();
    const broker = authority === "unrestricted-profile" || authority === "full-read-profile"
      ? new SandboxExecutionBroker({ mode: "workspace_write", cwd, permissionProfile: {
          fileSystem: authority === "unrestricted-profile"
            ? { kind: "unrestricted", entries: [] }
            : { kind: "restricted", entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "read" }, { path: { kind: "path", path: cwd }, access: "write" }] },
          network: "enabled",
        } })
      : new SandboxExecutionBroker({ mode: authority, cwd });
    Object.assign(session.services, { readOnlyDelegation: { kind: "read-only", ownerThreadId: "owner" }, sandboxExecutionBroker: broker });
    const registry = buildToolRegistry({ workspaceRoot: cwd, requireAdmission: false });
    const shell = registry.tools.find(tool => tool.name === "exec_command")!;
    expect(readOnlyDelegationToolRefusal(session, shell, { cmd: "git show HEAD:README.md" })).toBeUndefined();
    expect(readOnlyDelegationToolRefusal(session, shell, { cmd: "git log --oneline -5" })).toBeUndefined();
  });

});
