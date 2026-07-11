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

import { describe, expect, test } from "vitest";
import { createBrowserTool } from "../../../src/tools/BrowserTool/tool.js";
import { BROWSER_TOOL_NAME } from "../../../src/tools/BrowserTool/prompt.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import type { ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import type { PermissionResult } from "../../../src/permissions/types.js";

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
  });

  test("rejects navigate without a url", async () => {
    const result = await createBrowserTool().execute({ action: "navigate" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a url");
  });

  test("rejects click without a ref", async () => {
    const result = await createBrowserTool().execute({ action: "click" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires a ref");
  });
});
