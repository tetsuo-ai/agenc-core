/**
 * Browser tool contract: catalog metadata, per-action permissions, and input
 * validation. All hermetic — no browser is launched (validation and permission
 * checks run before any manager work).
 *
 * Revert-sensitivity: the "navigate asks, snapshot allows" split goes red if
 * checkPermissions stops distinguishing read-only actions from mutating ones;
 * the deferred/side-effecting metadata assertions go red if those fields are
 * dropped.
 */

import { describe, expect, test, vi } from "vitest";
import { createBrowserTool } from "../../../src/tools/BrowserTool/tool.js";
import { BROWSER_TOOL_NAME } from "../../../src/tools/BrowserTool/prompt.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import type { ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import type { PermissionResult } from "../../../src/permissions/types.js";
import {
  SandboxExecutionBroker,
  attachSandboxExecutionBroker,
} from "../../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../../src/sandbox/execution-lifecycle.js";
import type { ToolResult } from "../../../src/tools/types.js";

function evaluatorContext(): ToolEvaluatorContext {
  const permissionContext = createEmptyToolPermissionContext();
  return {
    getAppState: () => ({ toolPermissionContext: permissionContext }),
  } as unknown as ToolEvaluatorContext;
}

async function check(input: Record<string, unknown>): Promise<PermissionResult> {
  const tool = createBrowserTool();
  return await tool.checkPermissions!(input, evaluatorContext());
}

function expectConfirmedNoEffect(result: ToolResult, evidenceRef: string): void {
  expect(result.effectDisposition).toMatchObject({
    disposition: "confirmed_no_effect",
    evidenceKind: "boundary_not_crossed",
    evidenceRef,
  });
  expect(result.effectDisposition?.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
}

describe("Browser tool contract", () => {
  test("declares the deferred, side-effecting catalog contract", () => {
    const tool = createBrowserTool();
    expect(tool.name).toBe(BROWSER_TOOL_NAME);
    expect(tool.recoveryCategory).toBe("side-effecting");
    expect(tool.metadata?.deferred).toBe(true);
    expect(tool.metadata?.family).toBe("web");
    // No arg-directed FS writes → exempt from FS-write sandbox denial.
    expect(tool.metadata?.virtualNoFsWrites).toBe(true);
  });

  test("input schema requires action and forbids extra properties", () => {
    const schema = createBrowserTool().inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["action"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty("action");
    expect(schema.properties).toHaveProperty("ref");
  });
});

describe("Browser tool permissions", () => {
  test("read-only actions are auto-allowed (no prompt)", async () => {
    for (const action of ["snapshot", "screenshot", "get_text", "tabs"]) {
      const result = await check({ action });
      expect(result.behavior, action).toBe("allow");
    }
  });

  test("navigate asks for approval and offers a per-domain allow rule", async () => {
    const result = await check({ action: "navigate", url: "https://example.com/a" });
    expect(result.behavior).toBe("ask");
    if (result.behavior === "ask") {
      expect(result.message).toContain("example.com");
      expect(result.suggestions?.[0]).toMatchObject({
        type: "addRules",
        rules: [{ toolName: BROWSER_TOOL_NAME, ruleContent: "domain:example.com" }],
      });
    }
  });

  test("navigate is auto-allowed when a matching domain allow rule exists", async () => {
    const tool = createBrowserTool();
    const permissionContext = createEmptyToolPermissionContext({
      alwaysAllowRules: {
        localSettings: [`${BROWSER_TOOL_NAME}(domain:example.com)`],
      },
    });
    const ctx = {
      getAppState: () => ({ toolPermissionContext: permissionContext }),
    } as unknown as ToolEvaluatorContext;
    const result = await tool.checkPermissions!(
      { action: "navigate", url: "https://example.com/x" },
      ctx,
    );
    expect(result.behavior).toBe("allow");
  });

  test("acting actions (click/type) ask for approval", async () => {
    for (const input of [
      { action: "click", ref: "e1" },
      { action: "type", ref: "e1", text: "hi" },
    ]) {
      const result = await check(input);
      expect(result.behavior, input.action).toBe("ask");
    }
  });
});

describe("Browser tool validation (no browser launched)", () => {
  test("rejects an unknown action", async () => {
    const result = await createBrowserTool().execute({ action: "fly" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("action must be one of");
    expectConfirmedNoEffect(result, "tool:browser:input-validation");
  });

  test("rejects navigate without a url", async () => {
    const result = await createBrowserTool().execute({ action: "navigate" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a url");
    expectConfirmedNoEffect(result, "tool:browser:input-validation");
  });

  test("rejects click without a ref", async () => {
    const result = await createBrowserTool().execute({ action: "click" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a ref");
    expectConfirmedNoEffect(result, "tool:browser:input-validation");
  });

  test("settles a missing sandbox boundary before manager initialization", async () => {
    const result = await createBrowserTool().execute({ action: "tabs" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no authenticated runtime policy");
    expectConfirmedNoEffect(result, "tool:browser:sandbox-boundary-missing");
  });

  test("closes and detaches a broker-owned manager when child authority is disposed", async () => {
    const closeAll = vi.fn(async () => {});
    const listTabs = vi.fn(async () => []);
    const tool = createBrowserTool({
      manager: { closeAll, listTabs } as never,
    });
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/child-browser-workspace",
    });
    const args: Record<string, unknown> = { action: "tabs" };
    attachSandboxExecutionBroker(args, broker, "browser");

    const beforeDisposal = await tool.execute(args);
    expect(beforeDisposal.isError).toBeUndefined();
    expect(listTabs).toHaveBeenCalledOnce();

    await disposeSandboxExecutionBroker(broker);
    expect(closeAll).toHaveBeenCalledOnce();

    const afterDisposal = await tool.execute(args);
    expect(afterDisposal).toMatchObject({ isError: true });
    expect(afterDisposal.content).toContain("authority has been disposed");
    expectConfirmedNoEffect(
      afterDisposal,
      "tool:browser:sandbox-authority-disposed",
    );
    expect(listTabs).toHaveBeenCalledOnce();
  });

  test("keeps a failure after navigation dispatched as an unknown outcome", async () => {
    const closeAll = vi.fn(async () => {});
    const snapshot = vi.fn(async () => {
      throw new Error("snapshot failed after navigation");
    });
    const navigate = vi.fn(async () => ({ snapshot }));
    const tool = createBrowserTool({
      manager: { closeAll, navigate } as never,
    });
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/child-browser-workspace",
    });
    const args: Record<string, unknown> = {
      action: "navigate",
      url: "https://example.com",
    };
    attachSandboxExecutionBroker(args, broker, "browser");

    const result = await tool.execute(args);
    expect(navigate).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content).toContain("snapshot failed after navigation");
    expect(result.effectDisposition).toBeUndefined();

    await disposeSandboxExecutionBroker(broker);
    expect(closeAll).toHaveBeenCalledOnce();
  });
});
