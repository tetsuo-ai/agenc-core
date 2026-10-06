import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import {
  clearExitPlanModeApprovalsForTest,
  EXIT_PLAN_APPROVED_PLAN_ARG,
  recordExitPlanModeApproval,
} from "../../src/planning/exit-plan-approval.js";
import { getPlan, writePlan, writePlanSync } from "../../src/planning/plan-files.js";
import { StreamingToolExecutor } from "../../src/phases/_deps/tool-runtime.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { ToolRouter } from "../../src/tools/router.js";
import { createPlanningTools } from "../../src/tools/system/planning.js";

/**
 * ExitPlanMode asks the user to approve the plan its request shows. The
 * request used to snapshot the plan file, the tool then read the file again
 * after the approval, and an edit made while the user was reading was
 * implemented without ever being shown. The tool now executes the snapshot,
 * and refuses without effect when the file no longer holds it.
 */

function planTool(file: { content: string | null }) {
  const registry = new PermissionModeRegistry({
    ...createEmptyToolPermissionContext({ mode: "plan" }),
    prePlanMode: "default",
  });
  const writes: string[] = [];
  const tool = createPlanningTools({
    workflowController: {
      getPermissionModeRegistry: () => registry,
      readPlan: () => file.content,
      writePlan: async (content: string) => {
        writes.push(content);
        file.content = content;
      },
      getPlanFilePath: () => "/home/user/.agenc/plans/fixture.md",
    },
  }).find((candidate) => candidate.name === "ExitPlanMode");
  if (!tool) throw new Error("ExitPlanMode tool not registered");
  return { registry, tool, writes };
}

/** Arguments as the runtime hands them over: the snapshot is hidden. */
function withShownPlan(args: Record<string, unknown>, plan: string | null): Record<string, unknown> {
  Object.defineProperty(args, EXIT_PLAN_APPROVED_PLAN_ARG, {
    value: Object.freeze({ plan }),
    enumerable: false,
    configurable: true,
  });
  return args;
}

const shown = "# Plan\n\n- add the search route\n";
const edited = `${shown}- and drop the users table\n`;

describe("ExitPlanMode executes the plan its approval showed", () => {
  afterEach(() => clearExitPlanModeApprovalsForTest());

  it("approves the text that was shown, and refuses without effect once the file changed", async () => {
    const unchanged = planTool({ content: shown });
    recordExitPlanModeApproval("call-same", { action: "approve" });
    const approved = await unchanged.tool.execute(withShownPlan({ __callId: "call-same" }, shown));
    expect(approved.isError).not.toBe(true);
    expect(String(approved.content)).toContain(`## Approved Plan:\n${shown}`);
    expect(unchanged.registry.current().mode).toBe("default");

    const changed = planTool({ content: edited });
    recordExitPlanModeApproval("call-changed", { action: "approve" });
    const refused = await changed.tool.execute(withShownPlan({ __callId: "call-changed" }, shown));
    expect(refused.isError).toBe(true);
    expect(String(refused.content)).toContain("changed after approval was requested");
    expect(String(refused.content)).not.toContain("drop the users table");
    expect(refused.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(changed.registry.current().mode).toBe("plan");
    expect(changed.writes).toEqual([]);
  });

  it("refuses a request that showed no plan when a plan appears before the approval", async () => {
    const { registry, tool } = planTool({ content: "# A plan nobody saw\n" });
    recordExitPlanModeApproval("call-none", { action: "approve" });

    const result = await tool.execute(withShownPlan({ __callId: "call-none" }, null));

    expect(result.isError).toBe(true);
    expect(String(result.content)).not.toContain("A plan nobody saw");
    expect(result.effectDisposition).toMatchObject({ disposition: "confirmed_no_effect" });
    expect(registry.current().mode).toBe("plan");
  });

  it("treats a blank plan argument as absent, as the approval preview does", async () => {
    const file = { content: shown };
    const { tool, writes } = planTool(file);
    recordExitPlanModeApproval("call-blank", { action: "approve" });

    const result = await tool.execute(withShownPlan({ __callId: "call-blank", plan: "  \n " }, shown));

    expect(writes).toEqual([]);
    expect(file.content).toBe(shown);
    expect(String(result.content)).toContain(`## Approved Plan:\n${shown}`);
  });

  it("keeps revisions and plans the user edited in the approval, and refuses only a drifted file", async () => {
    const revise = planTool({ content: edited });
    recordExitPlanModeApproval("call-revise", { action: "revise", feedback: "shorter" });
    const revised = await revise.tool.execute(withShownPlan({ __callId: "call-revise" }, shown));
    expect(revised.isError).not.toBe(true);
    expect(String(revised.content)).toContain("shorter");
    expect(revise.registry.current().mode).toBe("plan");

    const userEdit = planTool({ content: edited });
    recordExitPlanModeApproval("call-edit", { action: "approve", plan: "# Plan edited by the user\n" });
    const approvedEdit = await userEdit.tool.execute(withShownPlan({ __callId: "call-edit" }, shown));
    expect(approvedEdit.isError).not.toBe(true);
    expect(userEdit.writes).toEqual(["# Plan edited by the user\n"]);
    expect(String(approvedEdit.content)).toContain("# Plan edited by the user");

    const drifted = planTool({ content: edited });
    recordExitPlanModeApproval("call-drift", { action: "approve" });
    const refused = await drifted.tool.execute(withShownPlan({ __callId: "call-drift" }, shown));
    expect(refused.isError).toBe(true);
    expect(drifted.registry.current().mode).toBe("plan");
  });
});

describe("the router and the phases executor hand ExitPlanMode the plan its approval request showed", () => {
  let home: string | undefined;
  afterEach(async () => {
    clearExitPlanModeApprovalsForTest();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  type Result = { readonly isError?: boolean; readonly content: unknown };

  /** Dispatch one ExitPlanMode call through the router, or through the phases executor's own path. */
  async function dispatch(
    route: "router" | "phases",
    tool: { readonly name: string; execute(args: Record<string, unknown>): Promise<unknown> },
    call: { readonly id: string; readonly name: string; readonly arguments: string },
    options: Record<string, unknown>,
  ): Promise<Result> {
    if (route === "router") {
      const router = new ToolRouter([{ tool: tool as never, supportsParallelToolCalls: false }]);
      return router.dispatchModelToolCall(call, {
        ...options,
        tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
      } as never) as Promise<Result>;
    }
    // No live router: the executor dispatches through the registry itself.
    const registry = {
      tools: [tool],
      toLLMTools: () => [],
      dispatch: async (entry: { readonly arguments: string }) => tool.execute(JSON.parse(entry.arguments)),
    };
    const executor = new StreamingToolExecutor({
      registry,
      liveToolDispatch: { router: { registry }, options },
    } as never);
    executor.addTool({} as never, call);
    executor.close();
    const results: Result[] = [];
    for await (const entry of executor.getRemainingResults()) results.push(entry.result as Result);
    expect(results).toHaveLength(1);
    return results[0]!;
  }

  it.each(["router", "phases"] as const)(
    "%s: does not implement an edit made while the approval was open, even when the model forges the snapshot",
    async (route) => {
      home = await mkdtemp(join(tmpdir(), "agenc-exit-plan-"));
      const sessionId = `conv-exit-plan-approved-${route}`;
      const context = { agencHome: home, sessionId };
      writePlanSync(context, shown);
      const registry = new PermissionModeRegistry({
        ...createEmptyToolPermissionContext({ mode: "plan" }),
        prePlanMode: "default",
      });
      const tool = createPlanningTools({
        workflowController: {
          getPermissionModeRegistry: () => registry,
          readPlan: () => getPlan(context),
          writePlan: async (content: string) => {
            await writePlan(context, content);
          },
        },
      }).find((candidate) => candidate.name === "ExitPlanMode")!;
      const requested: unknown[] = [];
      const resolver = {
        request: vi.fn(async (ctx: { readonly invocation: { readonly payload: { readonly arguments?: string } } }) => {
          requested.push(JSON.parse(ctx.invocation.payload.arguments ?? "{}"));
          // Someone edits the plan file while the user reads the approval sheet.
          await writePlan(context, edited);
          return { kind: "approved" as const };
        }),
      };

      const result = await dispatch(
        route,
        tool,
        {
          id: `call-exit-plan-${route}`,
          name: "ExitPlanMode",
          // A model cannot pass the approved plan itself.
          arguments: JSON.stringify({ [EXIT_PLAN_APPROVED_PLAN_ARG]: { plan: edited } }),
        },
        {
          session: {
            conversationId: sessionId,
            eventLog: new EventLog(),
            services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) },
          },
          turn: { subId: `turn-exit-plan-${route}` },
          agencHome: home,
          approvalPolicy: "never",
          sandboxMode: "workspace_write",
          approvalResolver: resolver,
          canUseTool: async () => ({ behavior: "ask", message: "Permission required to use ExitPlanMode" }),
          permissionContext: {},
        },
      );

      expect(resolver.request).toHaveBeenCalledOnce();
      expect(requested[0]).toMatchObject({ plan: shown });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("changed after approval was requested");
      expect(String(result.content)).not.toContain("drop the users table");
      expect(registry.current().mode).toBe("plan");
      expect(getPlan(context)).toBe(edited);
    },
  );
});
