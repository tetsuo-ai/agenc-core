import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ToolEvaluatorContext } from "../../src/permissions/evaluator.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch/tool.js";
import {
  createFileEditTool,
  createFileMultiEditTool,
} from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import {
  SESSION_AGENC_HOME_ARG,
  SESSION_ID_ARG,
  SESSION_ID_SIG_ARG,
  matchesVerifiedSessionPlanFile,
  recordSessionRead,
  signSessionId,
} from "../../src/tools/system/filesystem.js";
import {
  clearAllPlanSlugs,
  getPlanFilePath,
  setPlanSlug,
} from "../../src/planning/plan-files.js";

describe("signed active-session plan file permissions", () => {
  const sessionId = "test-session-plan-perm";
  let workspace = "";
  let agencHome = "";
  let planPath = "";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agenc-plan-perm-ws-"));
    agencHome = await mkdtemp(join(tmpdir(), "agenc-plan-perm-home-"));
    setPlanSlug({ agencHome, sessionId }, "ivory-bridge-aaed0227");
    planPath = getPlanFilePath({ agencHome, sessionId });
    await writeFile(planPath, "# Plan\n\n- [ ] Ship signed path\n", "utf8");
  });

  afterEach(async () => {
    clearAllPlanSlugs();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (agencHome) await rm(agencHome, { recursive: true, force: true });
    workspace = "";
    agencHome = "";
    planPath = "";
  });

  function signedArgs(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      file_path: planPath,
      cwd: workspace,
      [SESSION_ID_ARG]: sessionId,
      [SESSION_ID_SIG_ARG]: signSessionId(sessionId),
      [SESSION_AGENC_HOME_ARG]: agencHome,
      ...extra,
    };
  }

  function evaluator(
    mode: "acceptEdits" | "default" = "acceptEdits",
    context = createEmptyToolPermissionContext({ mode }),
  ): ToolEvaluatorContext {
    return {
      getAppState() {
        return {
          toolPermissionContext: context,
          denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
          autoModeActive: false,
        };
      },
      session: {},
    } as ToolEvaluatorContext;
  }

  test("matchesVerifiedSessionPlanFile uses the same signed context as execute", () => {
    expect(
      matchesVerifiedSessionPlanFile(planPath, workspace, signedArgs()),
    ).toBe(true);
    expect(
      matchesVerifiedSessionPlanFile(planPath, workspace, {
        ...signedArgs(),
        [SESSION_ID_SIG_ARG]: "deadbeef",
      }),
    ).toBe(false);
    expect(
      matchesVerifiedSessionPlanFile(
        join(agencHome, "plans", "not-active.md"),
        workspace,
        signedArgs({ file_path: join(agencHome, "plans", "not-active.md") }),
      ),
    ).toBe(false);
  });

  test("FileRead checkPermissions allows the signed plan then execute succeeds", async () => {
    const tool = createFileReadTool({ allowedPaths: [workspace] });
    const permission = tool.checkPermissions?.(signedArgs(), evaluator());
    expect(permission?.behavior).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error("expected FileRead allow");
    }
    const result = await tool.execute(permission.updatedInput ?? signedArgs());
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("Ship signed path");
  });

  test("Write checkPermissions allows the signed plan then execute succeeds", async () => {
    const original = await readFile(planPath, "utf8");
    const fileStats = await stat(planPath);
    recordSessionRead(sessionId, planPath, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
    const tool = createFileWriteTool({ allowedPaths: [workspace] });
    const args = signedArgs({ content: "# Plan\n\n- [x] Wrote\n" });
    const permission = tool.checkPermissions?.(args, evaluator());
    expect(permission?.behavior).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error("expected Write allow");
    }
    const result = await tool.execute(permission.updatedInput ?? args);
    expect(result.isError).toBeUndefined();
    await expect(readFile(planPath, "utf8")).resolves.toContain("Wrote");
  });

  test("Edit checkPermissions allows the signed plan then execute succeeds", async () => {
    const original = await readFile(planPath, "utf8");
    const fileStats = await stat(planPath);
    recordSessionRead(sessionId, planPath, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
    const tool = createFileEditTool({ allowedPaths: [workspace] });
    const args = signedArgs({
      old_string: "Ship signed path",
      new_string: "Ship edit",
    });
    const permission = tool.checkPermissions?.(args, evaluator());
    expect(permission?.behavior).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error("expected Edit allow");
    }
    const result = await tool.execute(permission.updatedInput ?? args);
    expect(result.isError).toBeUndefined();
    await expect(readFile(planPath, "utf8")).resolves.toContain("Ship edit");
  });

  test("MultiEdit checkPermissions allows the signed plan then execute succeeds", async () => {
    const original = await readFile(planPath, "utf8");
    const fileStats = await stat(planPath);
    recordSessionRead(sessionId, planPath, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
    const tool = createFileMultiEditTool({ allowedPaths: [workspace] });
    const args = signedArgs({
      edits: [
        { old_string: "Ship signed path", new_string: "Ship multi-edit" },
      ],
    });
    const permission = tool.checkPermissions?.(args, evaluator());
    expect(permission?.behavior).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error("expected MultiEdit allow");
    }
    const result = await tool.execute(permission.updatedInput ?? args);
    expect(result.isError).toBeUndefined();
    await expect(readFile(planPath, "utf8")).resolves.toContain(
      "Ship multi-edit",
    );
  });

  test("apply_patch checkPermissions allows the signed plan then execute succeeds", async () => {
    const original = await readFile(planPath, "utf8");
    const fileStats = await stat(planPath);
    recordSessionRead(sessionId, planPath, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
    const tool = createApplyPatchTool({
      cwd: workspace,
      allowedPaths: [workspace],
    });
    const args = {
      input: `*** Begin Patch
*** Update File: ${planPath}
@@
-# Plan
+# Patched plan
*** End Patch`,
      cwd: workspace,
      [SESSION_ID_ARG]: sessionId,
      [SESSION_ID_SIG_ARG]: signSessionId(sessionId),
      [SESSION_AGENC_HOME_ARG]: agencHome,
    };
    const permission = tool.checkPermissions?.(args, evaluator());
    expect(permission?.behavior).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error("expected apply_patch allow");
    }
    const result = await tool.execute(permission.updatedInput ?? args);
    expect(result.isError, String(result.content)).toBeUndefined();
    await expect(readFile(planPath, "utf8")).resolves.toContain("Patched plan");
  });

  test("explicit deny still wins over the signed plan exception", () => {
    const tool = createFileWriteTool({ allowedPaths: [workspace] });
    const denied = applyPermissionUpdate(
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
      {
        type: "addRules",
        destination: "userSettings",
        behavior: "deny",
        rules: [{ toolName: "Write", ruleContent: planPath }],
      },
    );
    const permission = tool.checkPermissions?.(
      signedArgs({ content: "nope" }),
      evaluator("acceptEdits", denied),
    );
    expect(permission?.behavior).toBe("deny");
  });

  test("invalid signatures, other sessions, and sibling AGENC_HOME files still ask", () => {
    const tool = createFileReadTool({ allowedPaths: [workspace] });
    const ctx = evaluator();
    expect(
      tool.checkPermissions?.(
        { ...signedArgs(), [SESSION_ID_SIG_ARG]: "not-a-signature" },
        ctx,
      )?.behavior,
    ).toBe("ask");
    expect(
      tool.checkPermissions?.(
        {
          ...signedArgs(),
          [SESSION_ID_ARG]: "other-session",
          [SESSION_ID_SIG_ARG]: signSessionId("other-session"),
        },
        ctx,
      )?.behavior,
    ).toBe("ask");
    const sibling = join(agencHome, "config.json");
    expect(
      tool.checkPermissions?.(signedArgs({ file_path: sibling }), ctx)
        ?.behavior,
    ).toBe("ask");
  });
});
