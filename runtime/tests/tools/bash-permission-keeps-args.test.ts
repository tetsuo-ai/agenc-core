import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolRouter } from "../../src/tools/router.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { createBashTool } from "../../src/tools/system/bash.js";
import { CanonicalBashTool } from "../../src/tools/canonicalToolSurface.js";
import { attachContextDefaults, hasPermissionsToUseTool } from "../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext, type ToolPermissionContext } from "../../src/permissions/types.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
import { withExplicitDangerBoundary } from "../helpers/explicit-danger-boundary.js";
import type { ApprovalCtx } from "../../src/permissions/guardian/arbiter.js";
import {
  buildGuardianApprovalRequest,
  guardianApprovalRequestActionText,
} from "../../src/permissions/guardian/approval-request.js";

// system.bash checks permission rules against `command` joined with `args`.
// Whatever the permission step decides, the call that runs must still carry
// every field the model sent: `cwd`, `args` and `timeoutMs`.

let workspace = "";
let sub = "";
beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "agenc-bash-perm-args-")));
  sub = join(workspace, "sub");
  await mkdir(sub);
  await writeFile(join(sub, "x y.txt"), "direct-mode-ok\n");
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

function dispatchFixture(permission: Partial<ToolPermissionContext>, decision: ReviewDecision = { kind: "denied" }) {
  const tool: Tool = createBashTool({ cwd: workspace, unrestricted: true });
  const execute = vi.spyOn(tool, "execute");
  const session = {
    eventLog: new EventLog(),
    services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) },
  } as unknown as ToolInvocation["session"];
  const turn = { subId: "bash-perm-args", cwd: workspace } as ToolInvocation["turn"];
  const resolver = { request: vi.fn(async (): Promise<ReviewDecision> => decision) };
  const toolPermissionContext = createEmptyToolPermissionContext(permission);
  const permissionContext = attachContextDefaults({
    getAppState: () => ({ toolPermissionContext }),
  });
  const options = {
    session, turn,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    approvalPolicy: "on-request" as const,
    sandboxMode: "danger_full_access" as const,
    approvalResolver: resolver,
    canUseTool: hasPermissionsToUseTool,
    permissionContext,
  };
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  const dispatch = (args: Record<string, unknown>) =>
    router.dispatchModelToolCall(
      { id: "bash-perm-args-call", name: "system.bash", arguments: JSON.stringify(args) },
      options as never,
    );
  return { execute, resolver, dispatch };
}

type DispatchFixture = ReturnType<typeof dispatchFixture>;
type DispatchResult = Awaited<ReturnType<DispatchFixture["dispatch"]>>;

// Shared assertion for the common case: the call succeeds and system.bash's
// execute() receives every field the model sent (`command`, `args`, `cwd`,
// `timeoutMs`), unchanged by the permission step.
function expectFullRoundTrip(fixture: DispatchFixture, result: DispatchResult) {
  expect(result.isError).not.toBe(true);
  expect(fixture.execute).toHaveBeenCalledTimes(1);
  const executed = fixture.execute.mock.calls[0]![0] as Record<string, unknown>;
  expect(executed.command).toBe("cat");
  expect(executed.args).toEqual(["x y.txt"]);
  expect(executed.cwd).toBe(sub);
  expect(executed.timeoutMs).toBe(45_000);
  expect(String(result.content)).toContain("direct-mode-ok");
}

const PERMISSION_CASES: ReadonlyArray<readonly [string, Partial<ToolPermissionContext>]> = [
  ["bypassPermissions mode", { mode: "bypassPermissions", isBypassPermissionsModeAvailable: true }],
  ["a content allow rule", { alwaysAllowRules: { userSettings: ["system.bash(pwd:*)", "system.bash(cat:*)"] } }],
  ["a whole-tool allow rule", { alwaysAllowRules: { userSettings: ["system.bash"] } }],
  [
    "the sandbox auto-allow",
    { autoAllowBashIfSandboxed: true } as Partial<ToolPermissionContext>,
  ],
];

describe("system.bash permission keeps the model's fields", () => {
  test("reads a relative cwd from the workspace, not from the daemon's working directory", async () => {
    expect(process.cwd()).not.toBe(workspace);
    const fixture = dispatchFixture({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true });
    const result = await fixture.dispatch({ command: "pwd", cwd: "sub" });
    expect(result.isError).not.toBe(true);
    expect(String(result.content).trim()).toBe(sub);
  });

  test.each(PERMISSION_CASES)("%s runs shell mode in the requested cwd", async (_label, permission) => {
    const fixture = dispatchFixture(permission);
    const result = await fixture.dispatch({ command: "pwd", cwd: sub, timeoutMs: 45_000 });
    expect(result.isError).not.toBe(true);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const executed = fixture.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(executed.command).toBe("pwd");
    expect(executed.cwd).toBe(sub);
    expect(executed.timeoutMs).toBe(45_000);
    expect(String(result.content)).toContain(sub);
  });

  test.each(PERMISSION_CASES)("%s keeps direct-mode args apart from the command", async (_label, permission) => {
    const fixture = dispatchFixture(permission);
    const result = await fixture.dispatch({ command: "cat", args: ["x y.txt"], cwd: sub, timeoutMs: 45_000 });
    expectFullRoundTrip(fixture, result);
  });

  test("an explicit ask that the user approves runs the call as sent and its approval shows argv and cwd", async () => {
    const fixture = dispatchFixture(
      { alwaysAskRules: { userSettings: ["system.bash(cat:*)"] } },
      { kind: "approved" },
    );
    const result = await fixture.dispatch({ command: "cat", args: ["x y.txt"], cwd: sub, timeoutMs: 45_000 });
    expect(fixture.resolver.request).toHaveBeenCalledTimes(1);
    const approvalCtx = (fixture.resolver.request.mock.calls[0] as unknown as [ApprovalCtx])[0];
    const payload = approvalCtx.invocation.payload;
    const approvalArgs = payload.kind === "function" ? JSON.parse(payload.arguments) as Record<string, unknown> : {};
    const approval = buildGuardianApprovalRequest(approvalCtx, approvalArgs);
    expect(approval.kind).toBe("shell");
    expect(approval.kind === "shell" ? approval.command : undefined).toEqual(["cat", "x y.txt"]);
    expect(guardianApprovalRequestActionText(approval)).toBe('["cat","x y.txt"]');
    expect(approval.cwd).toBe(sub);
    expectFullRoundTrip(fixture, result);
  });

  test("an allow rule written against the joined command runs the call as sent", async () => {
    const fixture = dispatchFixture({ alwaysAllowRules: { userSettings: ["system.bash(cat x y.txt)"] } });
    const result = await fixture.dispatch({ command: "cat", args: ["x y.txt"], cwd: sub });
    expect(fixture.resolver.request).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const executed = fixture.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(executed.args).toEqual(["x y.txt"]);
    expect(executed.cwd).toBe(sub);
    expect(String(result.content)).toContain("direct-mode-ok");
  });

  // Subagent sessions (turn-compat) run CanonicalBashTool.call() with the
  // permission result's updatedInput, so the canonical wrapper must keep the
  // fields as well.
  test.each(PERMISSION_CASES)("canonical system.bash under %s returns every field", async (_label, permission) => {
    const toolPermissionContext = createEmptyToolPermissionContext(permission);
    const result = await CanonicalBashTool.checkPermissions(
      { command: "cat", args: ["x y.txt"], cwd: sub, timeoutMs: 45_000 },
      { getAppState: () => ({ toolPermissionContext }), abortController: new AbortController() } as never,
    );
    expect(result.behavior).toBe("allow");
    expect(result.behavior === "allow" ? result.updatedInput : undefined).toMatchObject({
      command: "cat",
      args: ["x y.txt"],
      cwd: sub,
      timeoutMs: 45_000,
    });
  });

  // With `cwd` now reaching execution, the workspace write guard must stay
  // anchored at the trusted workspace root, not at the call's directory.
  describe("a cwd override does not move the workspace write guard", () => {
    const escape = () => ({ command: "printf hi > ../README.md", cwd: sub });

    test("preflight blocks a parent-directory workspace write", () => {
      const tool = createBashTool({ cwd: workspace, unrestricted: true });
      const failure = tool.preflight?.(escape());
      expect(failure?.message ?? "").toContain("shell_workspace_");
    });

    test("execute blocks a parent-directory workspace write", async () => {
      await writeFile(join(workspace, "README.md"), "original\n");
      const tool = createBashTool({ cwd: workspace, unrestricted: true });
      const result = await tool.execute(withExplicitDangerBoundary(escape()));
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("shell_workspace_");
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("original\n");
    });

    test("the router blocks it in bypassPermissions mode", async () => {
      await writeFile(join(workspace, "README.md"), "original\n");
      const fixture = dispatchFixture({ mode: "bypassPermissions", isBypassPermissionsModeAvailable: true });
      const result = await fixture.dispatch(escape());
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("shell_workspace_");
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("original\n");
    });
  });
});
