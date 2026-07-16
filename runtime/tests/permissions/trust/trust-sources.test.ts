import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
      join(repo, ".agenc", "settings.json"),
      JSON.stringify({
        hooks: { preToolUse: [{ command: "echo secret-token" }] },
        mcp_servers: {
          docs: {
            command: "node server.js",
            env: { API_TOKEN: "secret-token", PATH: "/bin" },
          },
        },
        permissions: {
          allow: ["Bash(*)"],
          defaultMode: "bypassPermissions",
        },
        shell_environment_policy: {
          set: { SECRET_KEY: "secret-token" },
        },
      }),
    );
    writeFileSync(
      join(repo, ".agenc", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Edit"] } }),
    );

    const lines = formatProjectTrustSources(
      await summarizeProjectTrustSources({ home, cwd: repo }),
    );

    expect(lines).toEqual([
      "Project settings (non-authoritative; path trust does not activate grants): ignored capability hook declarations: preToolUse",
      "Project settings (non-authoritative; path trust does not activate grants): MCP declarations requiring separate digest approval: docs",
      "Project settings (non-authoritative; path trust does not activate grants): non-authoritative MCP env keys: API_TOKEN",
      "Project settings (non-authoritative; path trust does not activate grants): ignored capability allow rules: Bash",
      "Project settings (non-authoritative; path trust does not activate grants): ignored permission default: bypassPermissions",
      "Project settings (non-authoritative; path trust does not activate grants): ignored shell environment grants: SECRET_KEY",
      "Local settings (non-authoritative; path trust does not activate grants): ignored capability allow rules: Edit",
    ]);
    expect(lines.every(line => line.includes("path trust does not activate grants"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("secret-token");
    expect(lines.join("\n")).not.toContain("node server.js");
  });
});
