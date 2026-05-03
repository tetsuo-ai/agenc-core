import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import {
  APPLY_PATCH_LARK_GRAMMAR,
  APPLY_PATCH_TOOL_NAME,
  createApplyPatchTool,
} from "./index.js";

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
