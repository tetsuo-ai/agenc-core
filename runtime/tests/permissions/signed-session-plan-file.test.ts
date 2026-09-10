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
import type { Tool } from "../../src/tools/Tool.js";

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

  async function markPlanRead(): Promise<void> {
    const original = await readFile(planPath, "utf8");
    const fileStats = await stat(planPath);
    recordSessionRead(sessionId, planPath, {
      content: original,
      timestamp: fileStats.mtimeMs,
      viewKind: "full",
    });
  }

  async function expectAllowThenExecute(
    label: string,
    tool: Tool,
    args: Record<string, unknown>,
    snippet: string,
  ): Promise<void> {
    const permission = tool.checkPermissions?.(args, evaluator());
    expect(permission?.behavior, label).toBe("allow");
    if (!permission || permission.behavior !== "allow") {
      throw new Error(`expected ${label} allow`);
    }
    const result = await tool.execute(permission.updatedInput ?? args);
    expect(result.isError, String(result.content)).toBeUndefined();
    await expect(readFile(planPath, "utf8")).resolves.toContain(snippet);
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

  test("FileRead/Write/Edit/MultiEdit allow the signed plan then execute", async () => {
    await markPlanRead();
    const allowed = [workspace];
    await expectAllowThenExecute(
      "FileRead",
      createFileReadTool({ allowedPaths: allowed }),
      signedArgs(),
      "Ship signed path",
    );
    await expectAllowThenExecute(
      "Write",
      createFileWriteTool({ allowedPaths: allowed }),
      signedArgs({ content: "# Plan\n\n- [x] Wrote\n" }),
      "Wrote",
    );
    await markPlanRead();
    await expectAllowThenExecute(
      "Edit",
      createFileEditTool({ allowedPaths: allowed }),
      signedArgs({
        old_string: "Wrote",
        new_string: "Ship edit",
      }),
      "Ship edit",
    );
    await markPlanRead();
    await expectAllowThenExecute(
      "MultiEdit",
      createFileMultiEditTool({ allowedPaths: allowed }),
      signedArgs({
        edits: [{ old_string: "Ship edit", new_string: "Ship multi-edit" }],
      }),
      "Ship multi-edit",
    );
  });

  test("apply_patch allows the signed plan then execute succeeds", async () => {
    await markPlanRead();
    await expectAllowThenExecute(
      "apply_patch",
      createApplyPatchTool({ cwd: workspace, allowedPaths: [workspace] }),
      {
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
      },
      "Patched plan",
    );
  });

  test("explicit deny still wins over the signed plan exception", () => {
    const denied = applyPermissionUpdate(
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
      {
        type: "addRules",
        destination: "userSettings",
        behavior: "deny",
        rules: [{ toolName: "Write", ruleContent: planPath }],
      },
    );
    const permission = createFileWriteTool({
      allowedPaths: [workspace],
    }).checkPermissions?.(
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
    expect(
      tool.checkPermissions?.(
        signedArgs({ file_path: join(agencHome, "config.json") }),
        ctx,
      )?.behavior,
    ).toBe("ask");
  });
});
