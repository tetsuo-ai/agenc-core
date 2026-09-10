import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlanFilePath, setPlanSlug, clearAllPlanSlugs } from "../../src/planning/plan-files.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { createFileEditTool, createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { attachContextDefaults, hasPermissionsToUseTool, type ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext, type PermissionMode } from "../../src/permissions/types.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { runToolUse } from "../../src/tools/execution.js";
import { StreamingToolExecutor } from "../../src/phases/_deps/tool-runtime.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { ConfigStore } from "../../src/config/store.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { planModeProducer } from "../../src/prompts/attachments/plan-mode.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import { signSessionId } from "../../src/tools/system/filesystem.js";
import { enforceRuntimeSandboxAttempt } from "../../src/tools/runtimes/sandboxing.js";
import { createEnterWorktreeTool } from "../../src/tools/system/worktree.js";

let root: string;
let cwd: string;
let home: string;
let planPath: string;
let session: ReturnType<typeof mkSession>["session"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-plan-permission-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd);
  const configStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd });
  session = mkSession({ cwd, services: { configStore } }).session;
  setPlanSlug({ sessionId: session.conversationId, agencHome: home }, "exact-own-plan");
  planPath = getPlanFilePath({ sessionId: session.conversationId, agencHome: home });
});

afterEach(async () => {
  await session.shutdown();
  clearAllPlanSlugs();
  rmSync(root, { recursive: true, force: true });
});

function context(mode: PermissionMode = "plan", behavior?: "ask" | "deny", ruleContent?: string): ToolEvaluatorContext {
  let permissions = createEmptyToolPermissionContext({ mode });
  if (behavior !== undefined) permissions = applyPermissionUpdate(permissions, {
    type: "addRules", destination: "session", behavior,
    rules: [{ toolName: "Write", ...(ruleContent !== undefined ? { ruleContent } : {}) }],
  });
  return attachContextDefaults({ session, getAppState: () => ({ toolPermissionContext: permissions }) });
}

describe("exact owning plan-file mutation authority", () => {
  it.each(["native", "child-wrapped", "child-direct"])("keeps no-plan session identity available to %s worktree dispatch", async (pipeline) => {
    rmSync(dirname(planPath), { recursive: true, force: true });
    clearAllPlanSlugs();
    const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "worktree-identity-test", ownerPid: process.pid });
    Object.assign(session.services, { executionAdmission: kernel.bindClient({ cwd, scope: { runId: session.conversationId, sessionId: session.conversationId, autonomous: false } }) });
    try {
      const native = {
        ...createEnterWorktreeTool({ cwd }),
        admissionEstimate: () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }),
      };
      const base: ToolRegistry = { tools: [native], toLLMTools: () => [], dispatch: async () => { throw new Error("unexpected fallback"); } };
      const registry = buildFilteredRegistry(base, { childConversationId: session.conversationId, getSession: () => session });
      const args = { name: "invalid name!" };
      let content: string;
      if (pipeline === "child-direct") {
        const result = await registry.dispatch({ id: "worktree-no-plan-direct", name: native.name, arguments: JSON.stringify(args) });
        content = String(result.content);
      } else {
        const tool = pipeline === "native" ? native : registry.tools[0]!;
        const turn = mkCtx({ cwd });
        const result = await runToolUse(JSON.stringify(args), {
          tool, currentTurnId: turn.subId,
          invocation: { session, turn, tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} }, callId: "worktree-no-plan", toolName: { name: tool.name }, payload: { kind: "function", arguments: "" }, source: "direct" },
          requestApproval: async () => ({ behavior: "allow", decisionAtTurnId: turn.subId }),
        });
        content = result.content;
      }
      expect(content).not.toContain("requires signed session");
      expect(content).toMatch(/name.*(?:letters|characters|segments)|invalid.*name/i);
      expect(existsSync(dirname(planPath))).toBe(false);
    } finally {
      kernel.close();
    }
  });

  it.each([".git", ".agents"])("does not waive unrelated %s metadata protection for a nested home", async (directory) => {
    const protectedHome = join(cwd, directory, "home");
    const configStore = new ConfigStore({ home: protectedHome, env: { AGENC_HOME: protectedHome }, cwd });
    Object.assign(session.services, { configStore });
    setPlanSlug({ sessionId: session.conversationId, agencHome: protectedHome }, "protected-plan");
    const protectedPath = getPlanFilePath({ sessionId: session.conversationId, agencHome: protectedHome });
    expect((await hasPermissionsToUseTool(createFileWriteTool({ allowedPaths: [cwd] }), { file_path: protectedPath, content: "bad" }, context())).behavior).toBe("deny");
  });

  it("does not grant native home access from a signed session ID alone", async () => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    const result = await tool.execute({
      file_path: planPath, content: "forged capability", __agencHome: home,
      __agencSessionId: session.conversationId,
      __agencSessionIdSig: signSessionId(session.conversationId),
    });
    expect(result.isError).toBe(true);
    expect(existsSync(planPath)).toBe(false);
  });

  it("pins the previously authorized owner instead of adopting another slug", async () => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "# Plan" }, context())).behavior).toBe("allow");
    setPlanSlug({ sessionId: session.conversationId, agencHome: home }, "replacement-slug");
    const changedPath = getPlanFilePath({ sessionId: session.conversationId, agencHome: home });
    expect((await hasPermissionsToUseTool(tool, { file_path: changedPath, content: "bad" }, context())).behavior).toBe("deny");
  });

  it.each(["default", "deny-exact", "deny-parent", "read-only"])("preserves the %s filesystem sandbox restriction", (restriction) => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    const mode = restriction === "read-only" ? "read_only" : "workspace_write";
    const turn = mkCtx({ cwd, fileSystemSandboxPolicy: {
      allowWrite: restriction === "read-only" ? [] : [cwd], allowRead: [], denyRead: [],
      denyWrite: restriction === "deny-exact" ? [planPath] : restriction === "deny-parent" ? [dirname(planPath)] : [],
    } } as never);
    const attempt = () => enforceRuntimeSandboxAttempt({ tool, args: { file_path: planPath, content: "# Plan" }, context: {
      callId: "plan-sandbox", toolName: tool.name, runtimeKind: "function", classification: { kind: "exclusive" },
      supportsParallelToolCalls: false, source: "direct", submittedAtMs: 0,
      approvalPolicy: "never", requestedSandboxMode: mode, sandboxMode: mode, approvalResolved: false, rawArgs: "{}",
      invocation: { session, turn, tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} }, callId: "plan-sandbox", toolName: { name: tool.name }, payload: { kind: "function", arguments: "{}" }, source: "direct" },
    } as never });
    if (restriction === "default") expect(attempt).not.toThrow();
    else expect(attempt).toThrow(/blocked/);
  });

  it("authorizes the actual advertised attachment path after cold slug-cache reconstruction", async () => {
    clearAllPlanSlugs();
    const attachments = await planModeProducer({
      sessionKey: session, agencHome: home, cwd, loadedTools: [], messages: [],
      getSession: () => session, permissionContext: createEmptyToolPermissionContext({ mode: "plan" }),
      subagentDepth: 0, signal: new AbortController().signal,
    }, getAttachmentTrackingState(session));
    expect(attachments).toContainEqual(expect.objectContaining({ kind: "plan_mode", planFilePath: planPath }));
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "# Plan" }, context())).behavior).toBe("allow");
  });

  it.each(["wrapped", "direct"])("re-derives child authority through the real %s filtered registry", async (dispatch) => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "plan-child-test", ownerPid: process.pid });
    const admission = kernel.bindClient({ cwd, scope: { runId: session.conversationId, sessionId: session.conversationId, autonomous: false }, budget: { runMaxCostUsd: 1 } });
    Object.assign(session.services, { executionAdmission: admission });
    try {
      const native = {
        ...createFileWriteTool({ allowedPaths: [cwd] }),
        admissionEstimate: () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }),
      };
      const base: ToolRegistry = { tools: [native], toLLMTools: () => [], dispatch: async () => { throw new Error("unexpected fallback"); } };
      const registry = buildFilteredRegistry(base, {
        childConversationId: session.conversationId, getSession: () => session,
        childToolPolicy: async (_tool, args) => {
          const decision = await hasPermissionsToUseTool(native, args, context());
          return decision.behavior === "allow" ? { behavior: "allow", updatedInput: args } : { behavior: "deny", message: "child plan denied" };
        },
      });
      const input = { file_path: planPath, content: "# Child plan", __agencSessionId: "forged-parent", __agencHome: join(root, "forged") };
      if (dispatch === "direct") {
        const result = await registry.dispatch({ id: "child-plan-direct", name: native.name, arguments: JSON.stringify(input) });
        expect(result.isError, String(result.content)).not.toBe(true);
        expect(admission.getUsageSummary?.().hasUnknownCost).toBe(false);
      } else {
        const tool = registry.tools[0]!;
        const turn = mkCtx({ cwd });
        const invocation: ToolInvocation = { session, turn, tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} }, callId: "child-plan-wrapped", toolName: { name: tool.name }, payload: { kind: "function", arguments: "" }, source: "direct" };
        const result = await runToolUse(JSON.stringify(input), { tool, invocation, currentTurnId: turn.subId, canUseTool: hasPermissionsToUseTool, permissionContext: context() });
        expect(result.isError, result.content).toBe(false);
      }
      expect(readFileSync(planPath, "utf8")).toBe(input.content);
      const denied = await registry.dispatch({ id: "child-plan-sibling", name: native.name, arguments: JSON.stringify({ ...input, file_path: planPath.replace(".md", "-agent-parent.md") }) });
      expect(denied.isError).toBe(true);
    } finally {
      kernel.close();
    }
  });

  it("keeps a descriptor-bound plan write from following a late parent exchange", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const tool = createFileWriteTool({ allowedPaths: [cwd], __testAfterPreWriteCheck: async () => {
      renameSync(dirname(planPath), `${dirname(planPath)}-old`);
      symlinkSync(outside, dirname(planPath), "junction");
    } });
    const turn = mkCtx({ cwd });
    const invocation: ToolInvocation = { session, turn, tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} }, callId: "plan-race", toolName: { name: tool.name }, payload: { kind: "function", arguments: "" }, source: "direct" };
    const result = await runToolUse(JSON.stringify({ file_path: planPath, content: "# Race plan" }), { tool, invocation, currentTurnId: turn.subId, canUseTool: hasPermissionsToUseTool, permissionContext: context() });
    expect(result.isError).toBe(true);
    expect(existsSync(join(outside, basename(planPath)))).toBe(false);
    expect(readFileSync(join(`${dirname(planPath)}-old`, basename(planPath)), "utf8")).toBe("# Race plan");
  });

  it.each(["Write", "Edit", "MultiEdit"])("permits unsigned owning %s input before dispatch, not sibling or workspace writes", async (name) => {
    const tool = name === "Write" ? createFileWriteTool({ allowedPaths: [cwd] }) : name === "Edit" ? createFileEditTool({ allowedPaths: [cwd] }) : createFileMultiEditTool({ allowedPaths: [cwd] });
    expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "# Plan" }, context())).behavior).toBe("allow");
    for (const filePath of [join(cwd, "app.mjs"), planPath.replace(".md", "-other.md"), planPath.replace(".md", "-agent-other.md"), join(dirname(planPath), ".slugs.json")]) {
      expect((await hasPermissionsToUseTool(tool, { file_path: filePath, content: "not allowed" }, context())).behavior).toBe("deny");
    }
  });

  it.each(["default", "plan", "acceptEdits", "bypassPermissions"] as const)("preserves explicit exact-path asks and denies in %s mode", async (mode) => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    for (const behavior of ["ask", "deny"] as const) {
      expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "# Plan" }, context(mode, behavior, planPath))).behavior).toBe(behavior);
      expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "# Plan" }, context(mode, behavior))).behavior).toBe(behavior);
    }
  });

  it("rejects forged owner fields, foreign homes, plugin writes and shell writes", async () => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    const foreignHome = join(root, "foreign");
    setPlanSlug({ sessionId: session.conversationId, agencHome: foreignHome }, "foreign-plan");
    const foreignPath = getPlanFilePath({ sessionId: session.conversationId, agencHome: foreignHome });
    const input = { file_path: foreignPath, content: "bad", __agencHome: foreignHome, __agencSessionId: session.conversationId };
    expect((await hasPermissionsToUseTool(tool, input, context())).behavior).toBe("deny");
    for (const untrustedTool of [
      { ...tool, metadata: { ...tool.metadata, source: "plugin" as const } },
      { ...tool, name: "system.bash" },
      { ...tool, name: "mcp.server.Write" },
    ]) expect((await hasPermissionsToUseTool(untrustedTool, { file_path: planPath, content: "bad" }, context())).behavior).toBe("deny");
    expect((await hasPermissionsToUseTool(tool, { file_path: planPath, content: "bad" }, { ...context(), session: { conversationId: session.conversationId, services: {} } as never })).behavior).toBe("deny");
  });

  it.each(["symlink", "hardlink", "parent-symlink", "traversal"])("rejects %s plan targets before approval", async (variant) => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, "untouched");
    let target = planPath;
    if (variant === "symlink") symlinkSync(outside, planPath);
    if (variant === "hardlink") linkSync(outside, planPath);
    if (variant === "parent-symlink") {
      const original = `${dirname(planPath)}-old`;
      renameSync(dirname(planPath), original);
      symlinkSync(original, dirname(planPath), "junction");
    }
    if (variant === "traversal") target = `${dirname(planPath)}/../plans/${basename(planPath)}`;
    expect((await hasPermissionsToUseTool(createFileWriteTool({ allowedPaths: [cwd] }), { file_path: target, content: "bad" }, context())).behavior).toBe("deny");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });

  it.each(["native", "streaming"])("executes the actual Write sink through %s with trusted exact args", async (pipeline) => {
    const tool = createFileWriteTool({ allowedPaths: [cwd] });
    const input = { file_path: planPath, content: "# Canonical plan\n" };
    const turn = mkCtx({ cwd, sandboxPolicy: { value: "workspace_write" }, approvalPolicy: { value: "on_request" } } as never);
    const approval = vi.fn(async () => ({ kind: "denied" as const }));
    if (pipeline === "native") {
      const invocation: ToolInvocation = { session, turn, tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} }, callId: "plan-native", toolName: { name: tool.name }, payload: { kind: "function", arguments: JSON.stringify(input) }, source: "direct" };
      const result = await runToolUse(JSON.stringify(input), { tool, invocation, currentTurnId: turn.subId, canUseTool: hasPermissionsToUseTool, permissionContext: context(), approvalResolver: { request: approval } });
      expect(result.isError, result.content).toBe(false);
    } else {
      const registry: ToolRegistry = { tools: [tool], toLLMTools: () => [], dispatch: async (call) => tool.execute(JSON.parse(call.arguments)) };
      const executor = new StreamingToolExecutor({ registry, liveToolDispatch: { router: { registry }, options: { session, turn, agencHome: home, approvalPolicy: "on_request", canUseTool: hasPermissionsToUseTool, permissionContext: context(), approvalResolver: { request: approval } } } });
      executor.addTool({}, { id: "plan-streaming", name: tool.name, arguments: JSON.stringify(input) });
      executor.close();
      const results = [];
      for await (const result of executor.getRemainingResults()) results.push(result.result);
      expect(results).toHaveLength(1);
      expect(results[0]?.isError, String(results[0]?.content)).not.toBe(true);
    }
    expect(approval).not.toHaveBeenCalled();
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, "utf8")).toBe(input.content);
  });
});
