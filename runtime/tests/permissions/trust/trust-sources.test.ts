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

    expect(lines).toEqual(
      expect.arrayContaining([
        "Project settings: hooks: preToolUse",
        "Project settings: MCP servers: docs",
        "Project settings: MCP env keys: API_TOKEN",
        "Project settings: allow rules: Bash",
        "Project settings: permission default: bypassPermissions",
        "Project settings: shell env keys: SECRET_KEY",
        "Local settings: allow rules: Edit",
      ]),
    );
    expect(lines.join("\n")).not.toContain("secret-token");
    expect(lines.join("\n")).not.toContain("node server.js");
  });
});
