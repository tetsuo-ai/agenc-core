import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import { checkConfigV2Migration } from "../../src/config/migration.js";
import { readStrictConfigLayer } from "../../src/config/repository.js";
import { McpStdioServerConfigSchema } from "../../src/services/mcp/types.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical per-tool config authority", () => {
  test.each([
    ["core boolean", "[tools_config]\nFileRead = false", "tools_config.FileRead"],
    [
      "core enabled field",
      "[tools_config.FileRead]\nenabled = false",
      "tools_config.FileRead.enabled",
    ],
    [
      "profile enabled field",
      "[profiles.dev.tools_config.FileRead]\nenabled = true",
      "dev.tools_config.FileRead.enabled",
    ],
    [
      "external MCP enabled field",
      '[mcp_servers.docs]\ncommand = "node"\n[mcp_servers.docs.tools.read]\nenabled = false',
      "mcp_servers.docs.tools.read.enabled",
    ],
    [
      "plugin MCP enabled field",
      '[plugins.plugins.demo.mcp_servers.local.tools.read]\nenabled = true',
      "plugins.plugins.demo.mcp_servers.local.tools.read.enabled",
    ],
  ])("strict v2 rejects removed %s", async (_label, body, field) => {
    const root = temporaryRoot("agenc-per-tool-v2");
    const path = join(root, "config.toml");
    write(path, `config_version = 2\n${body}\n`);

    await expect(readStrictConfigLayer(path, "user")).rejects.toThrow(field);
  });

  test("session MCP parsing rejects per-tool enabled", () => {
    const parsed = McpStdioServerConfigSchema().safeParse({
      command: "node",
      tools: { read: { enabled: false } },
    });
    expect(parsed.success).toBe(false);
  });

  test("explicit migration moves false to disabled_tools, drops true and inert image keys, and preserves lists and approval modes", async () => {
    const root = temporaryRoot("agenc-per-tool-migration");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[tools_config]",
      'enabled_tools = ["FileRead", "WebSearch"]',
      'disabled_tools = ["Grep"]',
      "web_search = false",
      "FileRead = true",
      "view_image = false",
      "[tools_config.Edit]",
      "enabled = false",
      'default_permission_mode = "never"',
      "[profiles.dev.tools_config]",
      "Write = false",
      "Glob = true",
      "[profiles.dev.tools_config.Bash]",
      "enabled = false",
      'default_permission_mode = "on-request"',
      "[mcp_servers.docs]",
      'command = "node"',
      'enabled_tools = ["read", "write"]',
      'disabled_tools = ["existing"]',
      "[mcp_servers.docs.tools.read]",
      "enabled = false",
      'default_permission_mode = "never"',
      "[mcp_servers.docs.tools.write]",
      "enabled = true",
      "[plugins.plugins.demo.mcp_servers.local]",
      'enabled_tools = ["lookup"]',
      "[plugins.plugins.demo.mcp_servers.local.tools.lookup]",
      "enabled = false",
      'default_permission_mode = "untrusted"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "per-tool-config-authority",
    });

    expect(plan.conflicts).toEqual([]);
    const content = plan.writes.find((write) => write.kind === "config")?.content;
    const migrated = parseToml(content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({
      tools_config: {
        enabled_tools: ["FileRead", "WebSearch"],
        disabled_tools: ["Grep", "Edit", "WebSearch"],
        Edit: { default_permission_mode: "never" },
      },
      profiles: {
        dev: {
          tools_config: {
            disabled_tools: ["Write", "Bash"],
            Bash: { default_permission_mode: "on-request" },
          },
        },
      },
      mcp_servers: {
        docs: {
          enabled_tools: ["read", "write"],
          disabled_tools: ["existing", "read"],
          tools: { read: { default_permission_mode: "never" } },
        },
      },
      plugins: {
        plugins: {
          demo: {
            mcp_servers: {
              local: {
                enabled_tools: ["lookup"],
                disabled_tools: ["lookup"],
                tools: {
                  lookup: { default_permission_mode: "untrusted" },
                },
              },
            },
          },
        },
      },
    });
    expect(migrated).not.toHaveProperty("tools_config.web_search");
    expect(migrated).not.toHaveProperty("tools_config.view_image");
    expect(content).not.toContain("enabled =");
  });
});
