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

import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from "../../../src/bootstrap/state.js";
import { persistPermissionUpdate } from "../../../src/utils/permissions/PermissionUpdate.js";
import { addPermissionRulesToSettings } from "../../../src/utils/permissions/permissionsLoader.js";
import { resetSettingsCache } from "../../../src/utils/settings/settingsCache.js";

describe("legacy permission persistence content boundary", () => {
  const previousCwd = getCwdState();
  const previousOriginalCwd = getOriginalCwd();
  const previousConfigDir = process.env.AGENC_CONFIG_DIR;
  let root = "";
  let repo = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agenc-permission-boundary-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    process.env.AGENC_CONFIG_DIR = join(root, "config-home");
    setOriginalCwd(repo);
    setCwdState(repo);
    resetSettingsCache();
  });

  afterEach(() => {
    setOriginalCwd(previousOriginalCwd);
    setCwdState(previousCwd);
    if (previousConfigDir === undefined) {
      delete process.env.AGENC_CONFIG_DIR;
    } else {
      process.env.AGENC_CONFIG_DIR = previousConfigDir;
    }
    resetSettingsCache();
    rmSync(root, { recursive: true, force: true });
  });

  test("repository files cannot persist grants but can persist restrictions", () => {
    for (const source of ["projectSettings", "localSettings"] as const) {
      expect(
        addPermissionRulesToSettings(
          {
            ruleValues: [{ toolName: "Bash", ruleContent: "*" }],
            ruleBehavior: "allow",
          },
          source,
        ),
      ).toBe(false);
    }
    const projectPath = join(repo, ".agenc", "settings.json");
    const localPath = join(repo, ".agenc", "settings.local.json");
    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(localPath)).toBe(false);

    expect(
      addPermissionRulesToSettings(
        {
          ruleValues: [{ toolName: "Bash", ruleContent: "curl:*" }],
          ruleBehavior: "deny",
        },
        "projectSettings",
      ),
    ).toBe(true);

    persistPermissionUpdate({
      type: "replaceRules",
      rules: [{ toolName: "Write" }],
      behavior: "allow",
      destination: "projectSettings",
    });
    persistPermissionUpdate({
      type: "setMode",
      mode: "bypassPermissions",
      destination: "projectSettings",
    });
    persistPermissionUpdate({
      type: "addDirectories",
      directories: ["/"],
      destination: "localSettings",
    });

    const project = JSON.parse(readFileSync(projectPath, "utf8")) as {
      permissions?: {
        allow?: string[];
        deny?: string[];
        defaultMode?: string;
      };
    };
    expect(project.permissions?.deny).toEqual(["Bash(curl:*)"]);
    expect(project.permissions?.allow).toBeUndefined();
    expect(project.permissions?.defaultMode).toBeUndefined();
    expect(existsSync(localPath)).toBe(false);
  });
});
