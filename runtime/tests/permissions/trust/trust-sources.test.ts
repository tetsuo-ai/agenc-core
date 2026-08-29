import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../config/store.js";
import {
  formatProjectTrustSources,
  summarizeProjectTrustSources,
} from "./trust-sources.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "agenc-trust-sources-"));
}

describe("project trust source summaries", () => {
  let home = "";
  let repo = "";

  beforeEach(() => {
    home = mkTmp();
    repo = mkTmp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".agenc"), { recursive: true });
  });

  afterEach(() => {
    for (const dir of [home, repo]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("summarizes project/local risky settings without exposing values", async () => {
    writeFileSync(
      join(repo, ".agenc", "config.toml"),
      [
        "config_version = 2",
        "[permissions]",
        'allow = ["system.bash(*)"]',
        'defaultMode = "bypassPermissions"',
        "[shell_environment_policy.set]",
        'SECRET_KEY = "secret-token"',
        'PATH = "/bin"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, ".agenc", "config.local.toml"),
      'config_version = 2\n[permissions]\nallow = ["Edit"]\n',
    );

    const configStore = new ConfigStore({
      home,
      cwd: repo,
      projectRoot: repo,
      projectTrusted: true,
      managedConfigPath: join(home, "missing-managed.toml"),
      managedDropInDir: join(home, "missing-managed.d"),
      env: { ...process.env, AGENC_HOME: home },
    });
    await configStore.reload();

    expect(configStore.sources("project")[0]?.config.permissions?.allow).toBeUndefined();
    expect(
      configStore.sources("project")[0]?.config.permissions?.defaultMode,
    ).toBeUndefined();
    expect(configStore.sources("local")[0]?.config.permissions?.allow).toBeUndefined();
    expect(
      configStore.ignored().map(({ scope, key }) => `${scope}:${key}`),
    ).toEqual([
      "project:permissions.allow",
      "project:permissions.defaultMode",
      "project:shell_environment_policy.set",
      "local:permissions.allow",
    ]);

    const lines = formatProjectTrustSources(
      await summarizeProjectTrustSources({ cwd: repo, configStore }),
    );

    expect(lines).toEqual([
      "Project config (non-authoritative; path trust does not activate grants): ignored capability allow rule declarations",
      "Project config (non-authoritative; path trust does not activate grants): ignored permission default declaration",
      "Project config (non-authoritative; path trust does not activate grants): ignored shell environment grants",
      "Local config (non-authoritative; path trust does not activate grants): ignored capability allow rule declarations",
    ]);
    expect(lines.every(line => line.includes("path trust does not activate grants"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("secret-token");
    expect(lines.join("\n")).not.toContain("node server.js");
    expect(lines.join("\n")).not.toContain("system.bash(*)");
    expect(lines.join("\n")).not.toContain("bypassPermissions");
    expect(lines.join("\n")).not.toContain("Edit");
  });
});
