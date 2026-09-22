import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
    expect(result.isError).not.toBe(true);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const executed = fixture.execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(executed.command).toBe("cat");
    expect(executed.args).toEqual(["x y.txt"]);
    expect(executed.cwd).toBe(sub);
    expect(executed.timeoutMs).toBe(45_000);
    expect(String(result.content)).toContain("direct-mode-ok");
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
});
