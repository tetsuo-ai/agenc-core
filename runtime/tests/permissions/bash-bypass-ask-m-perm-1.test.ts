import { describe, expect, test } from "vitest";

import { bashToolHasPermission } from "../../src/permissions/bash.js";
import type { ToolEvaluatorContext } from "../../src/permissions/bash.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import type { ToolPermissionContext } from "../../src/permissions/types.js";

// M-PERM-1 (core-todo.md): under bypassPermissions (--yolo), bashToolHasPermission
// short-circuited to `allow` for any subcommand set with no explicit deny, silently
// waiving user-configured content-specific ASK rules. The sandbox-override path guards
// this with aggregateAskCameFromRule; the bypass early-return did not. A rule-based ASK
// must survive bypass (evaluator.ts 1f).

function evalCtx(ctx: ToolPermissionContext): ToolEvaluatorContext {
  return { getAppState: () => ({ toolPermissionContext: ctx }) };
}

const ASK_RULE = { alwaysAskRules: { userSettings: ["Bash(git push:*)"] } };

describe("bashToolHasPermission — M-PERM-1 bypass must not waive ASK rules", () => {
  test("a rule-based ASK fires in default mode (baseline)", async () => {
    const result = await bashToolHasPermission(
      { command: "git push origin main" },
      evalCtx(createEmptyToolPermissionContext(ASK_RULE)),
    );
    expect(result.behavior).toBe("ask");
  });

  test("the same rule-based ASK still fires under bypassPermissions", async () => {
    const ctx = createEmptyToolPermissionContext({
      ...ASK_RULE,
      mode: "bypassPermissions",
    });
    const result = await bashToolHasPermission({ command: "git push origin main" }, evalCtx(ctx));
    expect(result.behavior).toBe("ask");
  });

  test("bypassPermissions still allows a command that matches no ASK/deny rule", async () => {
    const ctx = createEmptyToolPermissionContext({
      ...ASK_RULE,
      mode: "bypassPermissions",
    });
    const result = await bashToolHasPermission({ command: "ls -la" }, evalCtx(ctx));
    expect(result.behavior).toBe("allow");
  });

  test("bypassPermissions still denies a command that matches a deny rule", async () => {
    const ctx = createEmptyToolPermissionContext({
      alwaysDenyRules: { userSettings: ["Bash(rm:*)"] },
      mode: "bypassPermissions",
    });
    const result = await bashToolHasPermission({ command: "rm -rf scratch" }, evalCtx(ctx));
    expect(result.behavior).toBe("deny");
  });
});
