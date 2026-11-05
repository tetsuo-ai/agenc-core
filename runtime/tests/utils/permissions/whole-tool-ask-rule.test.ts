import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

vi.mock("bun:bundle", () => ({ feature: () => false }));

import type { Tool, ToolUseContext } from "../../../src/tools/Tool.js";
import { getEmptyToolPermissionContext } from "../../../src/tools/Tool.js";
import { hasPermissionsToUseTool } from "../../../src/utils/permissions/permissions.js";

function contextWithAskRule(toolName: string): ToolUseContext {
  let state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      alwaysAskRules: { session: [toolName] },
    },
  };
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      state = update(state);
    },
  } as unknown as ToolUseContext;
}

function toolAnswering(name: string, answer: unknown): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => answer,
  } as unknown as Tool;
}

describe("whole-tool ask rule", () => {
  it("keeps the tool's own deny", async () => {
    const tool = toolAnswering("ImagineEdit", {
      behavior: "deny",
      message: "Permission to read private/id.png has been denied.",
      decisionReason: { type: "other", reason: "read denied" },
    });
    await expect(
      hasPermissionsToUseTool(tool, {}, contextWithAskRule("ImagineEdit"), {} as never, "deny-under-ask"),
    ).resolves.toMatchObject({ behavior: "deny", message: "Permission to read private/id.png has been denied." });
  });

  it("keeps a safety-check reason", async () => {
    const tool = toolAnswering("Write", {
      behavior: "ask",
      message: "protected",
      decisionReason: { type: "safetyCheck", reason: "protected path", classifierApprovable: false },
    });
    await expect(
      hasPermissionsToUseTool(tool, {}, contextWithAskRule("Write"), {} as never, "safety-under-ask"),
    ).resolves.toMatchObject({ behavior: "ask", decisionReason: { type: "safetyCheck" } });
  });

  it("asks for the rule when the tool's own check would allow", async () => {
    const tool = toolAnswering("Write", { behavior: "allow", updatedInput: {} });
    await expect(
      hasPermissionsToUseTool(tool, {}, contextWithAskRule("Write"), {} as never, "allow-under-ask"),
    ).resolves.toMatchObject({ behavior: "ask", decisionReason: { type: "rule" } });
  });
});
