/**
 * Review B: the image ImagineEdit sends must pass FileRead's deny rules on
 * every approval path. A whole-tool ask rule now keeps that deny; a PreToolUse
 * hook that answers "ask" (alone or with that rule) must keep it too.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { arbitratePermissionMode } from "../../../src/permissions/guardian/arbiter.js";
import { hasPermissionsToUseTool, type ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import { applyPermissionUpdate } from "../../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext, type ToolPermissionContext } from "../../../src/permissions/types.js";
import { createProvider } from "../../../src/llm/provider.js";
import type { Session } from "../../../src/session/session.js";
import { createImagineEditTool } from "../../../src/tools/system/imagine-edit.js";
import {
  clearVeniceMediaModels,
  parseVeniceMediaModels,
  recordVeniceMediaModels,
} from "../../../src/tools/system/venice-media-models.js";
import { VENICE_MEDIA_LIST } from "../../tools/system/media-test-helpers.js";

const VENICE = "https://api.venice.ai/api/v1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const ENV: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

afterEach(() => clearVeniceMediaModels());

async function setup(extra: (permission: ToolPermissionContext) => ToolPermissionContext = (p) => p) {
  recordVeniceMediaModels({ baseURL: VENICE, bearer: "venice-session", transport: ENV }, parseVeniceMediaModels(VENICE_MEDIA_LIST));
  const root = await mkdtemp(join(tmpdir(), "rvb-imagine-hook-"));
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "id-scan.png"), PNG);
  const fetchImpl = vi.fn();
  const tool = createImagineEditTool({
    workspaceRoot: root, env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch,
    getSession: () => ({ services: { provider: createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" }) } }) as unknown as Session,
  });
  let permission = applyPermissionUpdate(createEmptyToolPermissionContext(), {
    type: "addRules", destination: "session", behavior: "deny", rules: [{ toolName: "FileRead", ruleContent: `${root}/private/**` }],
  });
  permission = extra(permission);
  const context = {
    session: {},
    getAppState: () => ({ toolPermissionContext: permission, denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: false }),
  } as unknown as ToolEvaluatorContext;
  return { tool, context };
}

const args = { image: "private/id-scan.png", prompt: "x" };
const hookAsk = { behavior: "ask" as const, hookName: "PreToolUse:review-media" };
const wholeToolAsk = (permission: ToolPermissionContext) => applyPermissionUpdate(permission, {
  type: "addRules", destination: "session", behavior: "ask", rules: [{ toolName: "ImagineEdit" }],
});

describe("review B: ImagineEdit's FileRead deny", () => {
  it("control: the evaluator denies the image, with or without a whole-tool ask rule", async () => {
    for (const extra of [undefined, wholeToolAsk]) {
      const { tool, context } = await setup(extra);
      await expect(hasPermissionsToUseTool(tool as never, args, context)).resolves.toMatchObject({ behavior: "deny" });
      const decision = await arbitratePermissionMode({ tool: tool as never, args, canUseTool: hasPermissionsToUseTool as never, permissionContext: context });
      expect(decision.kind).toBe("deny");
    }
  });

  it("stands when a PreToolUse hook answers ask", async () => {
    const { tool, context } = await setup();
    const decision = await arbitratePermissionMode({
      tool: tool as never, args, hookPermissionResult: hookAsk,
      canUseTool: hasPermissionsToUseTool as never, permissionContext: context,
    });
    expect(decision.kind).toBe("deny");
  });

  it("stands when a PreToolUse hook answers ask under a whole-tool ask rule", async () => {
    const { tool, context } = await setup(wholeToolAsk);
    const decision = await arbitratePermissionMode({
      tool: tool as never, args, hookPermissionResult: hookAsk,
      canUseTool: hasPermissionsToUseTool as never, permissionContext: context,
    });
    expect(decision.kind).toBe("deny");
  });
});
