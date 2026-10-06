import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkToolPathPermission } from "../../src/permissions/path-validation.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

test.each([
  { alias: ".vscode", target: ".git" },
  { alias: ".idea", target: ".agents" },
  { alias: "ordinary-link", target: ".git" },
])("alias $alias into $target keeps the strongest approval requirement", async ({ alias, target }) => {
  // Disposable synthetic directories only. No protected real user data touched.
  // Resolve the temp base first: on macOS both /tmp and /var are symlinks, so
  // an unresolved base would add a link layer this test is not measuring.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "agenc-safety-alias-review-"),
  );
  await mkdir(join(root, target));
  await symlink(join(root, target), join(root, alias));
  const path = join(root, alias, "config");
  const result = checkToolPathPermission({
    toolName: "Write", input: { file_path: path }, path, cwd: root,
    context: createEmptyToolPermissionContext({ mode: "auto" }), operationType: "write",
  });
  expect(result.behavior).toBe("ask");
  expect(result.decisionReason).toMatchObject({
    type: "safetyCheck", classifierApprovable: false,
  });
});
