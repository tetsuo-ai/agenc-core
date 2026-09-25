import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { checkToolPathPermission } from "../../src/permissions/path-validation.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

test.each(["allow", "deny"] as const)(
  "canonical non-glob prefix is used for matching, behavior=%s",
  async (behavior) => {
    // Resolve the temp base first: on macOS both /tmp and /var are symlinks,
    // so an unresolved base would add a link layer this test is not measuring.
    const parent = await mkdtemp(
      join(await realpath(tmpdir()), "agenc-rule-prefix-review-"),
    );
    const root = join(parent, "project");
    await mkdir(join(root, "actual-src"), { recursive: true });
    await mkdir(join(parent, "home"));
    await symlink(join(root, "actual-src"), join(root, "src"));
    const store = new ConfigStore({ home: join(parent, "home"), cwd: root, projectRoot: root });
    await store.reload();
    const toolName = behavior === "deny" ? "FileRead" : "Write";
    const target = join(root, "src", "file.txt");
    const context = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules", destination: "projectSettings", behavior,
      rules: [{ toolName, ruleContent: "./src/**" }],
    });
    await runWithCanonicalSettingsAuthority(store, () => {
      const result = checkToolPathPermission({
        toolName, input: { file_path: target }, path: target, cwd: root,
        context, operationType: behavior === "deny" ? "read" : "write",
      });
      expect(result.behavior).toBe(behavior);
      expect(result.decisionReason?.type).toBe("rule");
    });
  },
);
