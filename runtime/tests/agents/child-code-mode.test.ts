import { describe, expect, test, vi } from "vitest";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { Tool } from "../../src/tools/types.js";
import { readInvokingSession } from "../../src/tools/runtimes/context.js";
import { mkCtx, mkSession } from "../fixtures.js";

function setup(toolOverrides: Partial<Tool> = {}, options: Partial<Parameters<typeof buildFilteredRegistry>[1]> = {}) {
  const execute = vi.fn(async (args: Record<string, unknown>) => ({
    content: JSON.stringify({ child: readInvokingSession(args)?.conversationId, value: args.value }),
  }));
  const tool: Tool = { name: "Probe", description: "Read probe", inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
    isReadOnly: true, recoveryCategory: "idempotent", requiresApproval: false, execute, ...toolOverrides };
  const parent: ToolRegistry = { tools: [tool], toLLMTools: () => [], dispatch: vi.fn(), dispatchCodeModeNestedTool: vi.fn() };
  const { session } = mkSession();
  const registry = buildFilteredRegistry(parent, { childConversationId: session.conversationId,
    getSession: () => session, ...options }) as ToolRegistry;
  const call = (name = "Probe", input: unknown = { value: "child-result" }, abortSignal?: AbortSignal) => {
    expect(registry.dispatchCodeModeNestedTool).toBeTypeOf("function");
    return registry.dispatchCodeModeNestedTool!({ id: "nested-child", name, input, turn: mkCtx(), abortSignal });
  };
  return { call, session, execute, parent };
}

describe("a child's code-mode nested tools", () => {
  test("run with the child's runtime context, without calling the parent registry", async () => {
    const { call, execute, parent, session } = setup();
    expect(await call()).toMatchObject({ content: JSON.stringify({ child: session.conversationId, value: "child-result" }) });
    expect(execute).toHaveBeenCalledOnce();
    expect(parent.dispatchCodeModeNestedTool).not.toHaveBeenCalled();
    expect(parent.dispatch).not.toHaveBeenCalled();
  });
  test.each([
    { allowlist: ["Other"] }, { disabledTools: new Set(["Probe"]) },
    { childToolPolicy: async () => ({ behavior: "deny" as const, message: "child policy refused" }) },
  ])("enforces child restrictions %j", async options => {
    const { call, execute } = setup({}, options);
    expect(await call()).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  test("checks the child's deny rules even when the parent would allow the tool", async () => {
    const { call, execute, session } = setup();
    const permissions = session.services.permissionModeRegistry!;
    await permissions.update({ ...permissions.current(), alwaysDenyRules: { session: ["Probe"] } });
    expect(await call()).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  test.each([
    { isReadOnly: false }, { recoveryCategory: "side-effecting" as const }, { requiresApproval: true },
  ])("keeps the nested side-effect gate %j", async override => {
    const { call, execute } = setup(override);
    expect(await call()).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  test.each(["throw", "ask"])("fails closed when the tool-specific permission check says %s", async behavior => {
    const { call, execute } = setup({ checkPermissions: async () => {
      if (behavior === "throw") throw new Error("check failed");
      return { behavior: "ask", message: "approval required" };
    } });
    expect(await call()).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  test("a turn ended during a permission check cannot execute afterward", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { call, execute } = setup({ checkPermissions: async () => {
      entered(); await gate;
      return { behavior: "allow", updatedInput: {} };
    } });
    const controller = new AbortController();
    const pending = call("Probe", {}, controller.signal);
    await started; controller.abort(); release();
    expect(await pending).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
  test("refuses control tools, malformed input, and cancellation before execution", async () => {
    const { call, execute } = setup();
    for (const name of ["exec", "wait", "system.searchTools"]) expect(await call(name)).toMatchObject({ isError: true });
    expect(await call("Probe", ["bad"])).toMatchObject({ isError: true });
    const controller = new AbortController(); controller.abort();
    expect(await call("Probe", {}, controller.signal)).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
