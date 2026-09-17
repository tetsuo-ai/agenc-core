import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { checkToolPathPermission } from "../../src/permissions/path-validation.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";

test.each([
  { behavior: "deny" as const, aliasRoot: false },
  { behavior: "allow" as const, aliasRoot: false },
  { behavior: "deny" as const, aliasRoot: true },
  { behavior: "allow" as const, aliasRoot: true },
])(
  "project $behavior resolves root consistently, symlinked=$aliasRoot",
  async ({ behavior, aliasRoot }) => {
    // Disposable synthetic fixture only, deliberately retained for inspection.
    const parent = await mkdtemp("/private/tmp/agenc-rule-symlink-review-");
    const project = join(parent, "real-project");
    const alias = join(parent, "project-alias");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(parent, "home"));
    await symlink(project, alias);
    const sourceRoot = aliasRoot ? alias : project;
    const store = new ConfigStore({
      home: join(parent, "home"), cwd: sourceRoot, projectRoot: sourceRoot,
    });
    await store.reload();
    expect(store.projectRoot).toBe(sourceRoot);
    const canonicalCwd = await realpath(project);
    const target = join(canonicalCwd, "src", "new.txt");
    const toolName = behavior === "deny" ? "FileRead" : "Write";
    const context = applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules", destination: "projectSettings", behavior,
      rules: [{ toolName, ruleContent: "./src/**" }],
    });
    await runWithCanonicalSettingsAuthority(store, () => {
      const result = checkToolPathPermission({
        toolName, input: { file_path: target }, path: target,
        cwd: canonicalCwd, context, operationType: behavior === "deny" ? "read" : "write",
      });
      expect(result.behavior).toBe(behavior);
      expect(result.decisionReason?.type).toBe("rule");
    });
  },
);
