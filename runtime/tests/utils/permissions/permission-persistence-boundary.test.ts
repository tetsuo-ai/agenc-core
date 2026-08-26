import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseToml } from "../../../src/config/loader.js";
import { addPermissionRulesToConfig } from "../../../src/permissions/settings.js";
import { persistPermissionUpdate } from "../../../src/utils/permissions/PermissionUpdate.js";

describe("canonical permission persistence content boundary", () => {
  let root = "";
  let repo = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agenc-permission-boundary-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("repository files cannot persist grants but can persist restrictions", async () => {
    const env = { cwd: repo, home: join(root, "home") };
    for (const source of ["projectSettings", "localSettings"] as const) {
      expect(
        await addPermissionRulesToConfig({
          destination: source,
          rules: [{ toolName: "system.bash", ruleContent: "*" }],
          behavior: "allow",
          env,
        }),
      ).toBe(false);
    }
    const projectPath = join(repo, ".agenc", "config.toml");
    const localPath = join(repo, ".agenc", "config.local.toml");
    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(localPath)).toBe(false);

    expect(
      await addPermissionRulesToConfig({
        destination: "projectSettings",
        rules: [{ toolName: "system.bash", ruleContent: "curl:*" }],
        behavior: "deny",
        env,
      }),
    ).toBe(true);

    await persistPermissionUpdate(
      {
        type: "replaceRules",
        rules: [{ toolName: "Write" }],
        behavior: "allow",
        destination: "projectSettings",
      },
      env,
    );
    await expect(
      persistPermissionUpdate(
        {
          type: "setMode",
          mode: "bypassPermissions",
          destination: "projectSettings",
        },
        env,
      ),
    ).rejects.toThrow(/exact-cwd consent transition/u);
    await persistPermissionUpdate(
      {
        type: "addDirectories",
        directories: ["/"],
        destination: "localSettings",
      },
      env,
    );

    const project = parseToml(readFileSync(projectPath, "utf8")) as {
      permissions?: {
        allow?: string[];
        deny?: string[];
        defaultMode?: string;
      };
    };
    expect(project.permissions?.deny).toEqual(["system.bash(curl:*)"]);
    expect(project.permissions?.allow).toBeUndefined();
    expect(project.permissions?.defaultMode).toBeUndefined();
    expect(existsSync(localPath)).toBe(false);
  });
});
