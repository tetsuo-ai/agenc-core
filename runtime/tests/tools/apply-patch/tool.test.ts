import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { APPLY_PATCH_LARK_GRAMMAR, APPLY_PATCH_TOOL_NAME, createApplyPatchTool } from "./tool.js";
import { createEmptyToolPermissionContext } from "../../permissions/types.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-apply-patch-tool-"));
}

describe("apply_patch tool", () => {
  test("exports the donor Lark grammar", () => {
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain("start: begin_patch hunk+ end_patch");
    expect(APPLY_PATCH_LARK_GRAMMAR).toContain(
      'change_line: ("+" | "-" | " ") /(.*)/ LF',
    );
  });

  test("executes JSON-shaped patch input", async () => {
    const root = await tempRoot();
    const tool = createApplyPatchTool({ cwd: root, allowedPaths: [root] });

    const result = await tool.execute({
      input: `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "Success. Updated the following files:\nA hello.txt\n",
    );
    await expect(readFile(join(root, "hello.txt"), "utf8")).resolves.toBe(
      "hello\n",
    );
  });

  test("denies (fail-closed) on an unparseable patch in checkPermissions", () => {
    // SECURITY (audit #2): a malformed patch must NOT fail open. The
    // previous `behavior: "allow"` let unparseable input skip the
    // per-target path-permission check entirely.
    const tool = createApplyPatchTool({ cwd: "/tmp", allowedPaths: ["/tmp"] });
    const context = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext(),
      }),
    } as unknown as Parameters<NonNullable<typeof tool.checkPermissions>>[1];

    const decision = tool.checkPermissions!(
      { input: "this is not a valid apply_patch payload" },
      context,
    );

    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
      expect(decision.message).toContain("could not be parsed");
    }
  });

  test("checkPermissions ignores model-supplied __agencSessionAllowedRoots", () => {
    // SECURITY (audit #1/#4): apply_patch must check writes against the
    // TRUSTED closure roots only. A model-supplied
    // `__agencSessionAllowedRoots:["/"]` must not widen the permitted
    // write target. Writing to /etc must therefore not be auto-allowed.
    const tool = createApplyPatchTool({ cwd: "/tmp", allowedPaths: ["/tmp"] });
    const context = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext(),
      }),
    } as unknown as Parameters<NonNullable<typeof tool.checkPermissions>>[1];

    const decision = tool.checkPermissions!(
      {
        input: `*** Begin Patch
*** Add File: /etc/agenc-escape.txt
+pwned
*** End Patch`,
        __agencSessionAllowedRoots: ["/"],
      },
      context,
    );

    // The model-supplied root must not have made /etc writable.
    expect(decision.behavior).not.toBe("allow");
  });

  test("declares a deferred mutating filesystem surface", () => {
    const tool = createApplyPatchTool({ cwd: "/tmp", allowedPaths: ["/tmp"] });

    expect(tool.name).toBe(APPLY_PATCH_TOOL_NAME);
    expect(tool.metadata).toMatchObject({
      family: "filesystem",
      source: "builtin",
      hiddenByDefault: true,
      mutating: true,
      deferred: true,
    });
    expect(tool.requiresApproval).toBe(true);
  });
});
