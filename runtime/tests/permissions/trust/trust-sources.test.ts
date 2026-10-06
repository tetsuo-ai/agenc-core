import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../config/store.js";
import type { AgenCConfig } from "../../config/schema.js";
import {
  projectTrustReviewIsEmpty,
  reviewProjectTrust,
  summarizeProjectTrustReview,
} from "./trust-sources.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "agenc-trust-sources-"));
}

describe("project trust review", () => {
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

  async function review(projectTrusted = false) {
    const configStore = new ConfigStore({
      home,
      cwd: repo,
      projectRoot: repo,
      projectTrusted,
      managedConfigPath: join(home, "missing-managed.toml"),
      managedDropInDir: join(home, "missing-managed.d"),
      env: { ...process.env, AGENC_HOME: home },
    });
    await configStore.reload();
    return reviewProjectTrust({
      projectRoot: repo,
      config: configStore.current(),
    });
  }

  test("an untrusted repo lists the hooks, MCP servers and env it ships", async () => {
    writeFileSync(
      join(repo, ".agenc", "config.toml"),
      [
        "config_version = 2",
        "[[hooks.PreToolUse]]",
        'hooks = [{ type = "command", command = "./scripts/audit.sh" }]',
        "[[hooks.Stop]]",
        'hooks = [{ type = "command", command = "./scripts/notify.sh" }]',
        "[mcp_servers.github]",
        'transport = "stdio"',
        'command = "npx"',
        'args = ["github-mcp"]',
        "[shell_environment_policy.set]",
        'SECRET_KEY = "secret-token"',
        'API_URL = "https://staging.example.com"',
        "",
      ].join("\n"),
    );

    const result = await review();

    expect(result.repoItems).toEqual([
      {
        label: "Hooks",
        values: [
          "./scripts/audit.sh before each tool",
          "./scripts/notify.sh when a turn ends",
        ],
      },
      { label: "MCP servers", values: ["github (npx github-mcp)"] },
      { label: "Shell env", values: ["API_URL, SECRET_KEY"] },
    ]);
    expect(result.userItems).toEqual([]);
    expect(projectTrustReviewIsEmpty(result)).toBe(false);
    expect(summarizeProjectTrustReview(result)).toBe(
      "hooks, MCP servers, shell env",
    );
    // Environment values can be secrets; only names reach the card.
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("staging.example.com");
  });

  test("the review does not depend on whether the store loaded the repo trusted", async () => {
    writeFileSync(
      join(repo, ".agenc", "config.toml"),
      'config_version = 2\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "make check" }]\n',
    );

    expect((await review(true)).repoItems).toEqual(
      (await review(false)).repoItems,
    );
  });

  test("settings a repo can never set are not listed as turned on by trust", async () => {
    writeFileSync(
      join(repo, ".agenc", "config.toml"),
      [
        "config_version = 2",
        'sandbox_mode = "read-only"',
        "[permissions]",
        'allow = ["system.bash(*)"]',
        "[statusLine]",
        'type = "command"',
        'command = "./status.sh"',
        "",
      ].join("\n"),
    );

    const result = await review();

    // sandbox_mode applies without trust, permission grants and a repo status
    // line are dropped even when trusted: trust turns none of them on.
    expect(result.repoItems).toEqual([]);
    expect(projectTrustReviewIsEmpty(result)).toBe(true);
  });

  test("other repo settings are named by key", async () => {
    writeFileSync(
      join(repo, ".agenc", "config.local.toml"),
      'config_version = 2\nmodel = "grok-4.5"\n',
    );

    expect((await review()).repoItems).toEqual([
      { label: "Settings", values: ["model"] },
    ]);
  });

  test("the user's own hooks and status line count, because they run only in trusted folders", async () => {
    writeFileSync(
      join(home, "config.toml"),
      [
        "config_version = 2",
        "[[hooks.PostToolUse]]",
        'matcher = "Edit"',
        'hooks = [{ type = "command", command = "npm run lint" }]',
        "[statusLine]",
        'type = "command"',
        'command = "~/bin/status.sh"',
        "",
      ].join("\n"),
    );

    const result = await review();

    expect(result.repoItems).toEqual([]);
    expect(result.userItems).toEqual([
      { label: "Your hooks", values: ["npm run lint after Edit"] },
      { label: "Status line", values: ["~/bin/status.sh"] },
    ]);
    expect(summarizeProjectTrustReview(result)).toBe(
      "your hooks, your status line",
    );
  });

  test("a repo with no AgenC config and a user with no hooks has nothing to review", async () => {
    const result = await review();
    expect(result).toEqual({ repoItems: [], userItems: [] });
    expect(projectTrustReviewIsEmpty(result)).toBe(true);
  });
});

describe("trust review wording", () => {
  let empty = "";

  beforeEach(() => {
    empty = mkTmp();
  });

  afterEach(() => {
    rmSync(empty, { recursive: true, force: true });
  });

  test("hooks read as a command and when it runs", async () => {
    const config = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "./boot.sh" }] }],
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "./all.sh" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "./bash.sh" }] },
          { enabled: false, hooks: [{ type: "command", command: "./off.sh" }] },
        ],
        CustomEvent: [{ hooks: [{ type: "command", command: "./x.sh" }] }],
      },
    } as unknown as AgenCConfig;
    const result = await reviewProjectTrust({ projectRoot: empty, config });
    expect(result.userItems).toEqual([
      {
        label: "Your hooks",
        values: [
          "./all.sh before each tool",
          "./bash.sh before Bash",
          "./boot.sh when a session starts",
          "./x.sh on CustomEvent",
        ],
      },
    ]);
  });

  test("MCP servers read as a name and what they start", async () => {
    mkdirSync(join(empty, ".agenc"));
    writeFileSync(
      join(empty, ".agenc", "config.toml"),
      [
        "config_version = 2",
        "[mcp_servers.web]",
        'transport = "http"',
        'endpoint = "https://mcp.example.com"',
        "[mcp_servers.off]",
        'command = "x"',
        "enabled = false",
        "[mcp_servers.local]",
        'command = "node"',
        'args = ["server.js"]',
        "",
      ].join("\n"),
    );
    const result = await reviewProjectTrust({ projectRoot: empty, config: {} });
    expect(result.repoItems).toEqual([
      {
        label: "MCP servers",
        values: ["local (node server.js)", "web (https://mcp.example.com)"],
      },
    ]);
  });
});
