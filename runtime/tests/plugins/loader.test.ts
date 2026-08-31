import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  deletePluginDataDir,
  getPluginDataDir,
  getPluginDataDirSize,
  getPluginsDirectory,
  pluginFilesystemKey,
  sanitizePluginId,
} from "./directories.js";
import {
  createPluginFromPath,
  discoverPluginRoots,
  discoverPluginSkillRoots,
  loadPlugins,
} from "./loader.js";
import {
  loadPluginManifest,
  PLUGIN_MANIFEST_RELATIVE_PATH,
} from "./manifest.js";
import {
  normalizePluginManifest,
  PluginManifestError,
  resolveManifestRelativePath,
} from "./manifest-schema.js";
import { validateManifest, validatePluginContents } from "./validation.js";

describe("plugin manifest", () => {
  test("loads the canonical manifest and normalizes interface prompts", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "alpha");
      await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), {
        name: "canonical-name",
        version: " 1.2.3 ",
        interface: {
          displayName: "Canonical",
          defaultPrompt: [
            "  first   prompt  ",
            "second prompt",
            "third prompt",
            "ignored prompt",
          ],
        },
      });

      const parsed = await loadPluginManifest(pluginRoot);

      expect(parsed?.manifest.name).toBe("canonical-name");
      expect(parsed?.manifest.version).toBe("1.2.3");
      expect(parsed?.manifest.interface?.defaultPrompt).toEqual([
        "first prompt",
        "second prompt",
        "third prompt",
      ]);
    });
  });

  test("rejects a retired root manifest even when the canonical manifest exists", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "alpha");
      await writeJson(join(pluginRoot, "plugin.json"), { name: "retired" });
      await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), {
        name: "canonical",
      });

      await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(
        "Retired root plugin manifest detected",
      );
    });
  });

  test("rejects paths that are not normalized beneath the plugin root", async () => {
    await withTempDir(async (root) => {
      expect(() =>
        resolveManifestRelativePath(root, "commands", "../outside.md"),
      ).toThrow("must start with ./");
      expect(() =>
        resolveManifestRelativePath(root, "commands", "./nested/../outside.md"),
      ).toThrow("must be normalized");
      expect(() =>
        resolveManifestRelativePath(root, "commands", "./"),
      ).toThrow("must not be ./");
    });
  });

  test("fails validation for retired root plugin manifests with migration guidance", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "local-plugin");
      await writeJson(join(pluginRoot, "plugin.json"), {
        name: "local-plugin",
        commands: "./commands",
      });
      await mkdir(join(pluginRoot, "commands"), { recursive: true });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.fileType).toBe("plugin");
      expect(result.errors[0]?.message).toContain(
        "move the manifest there and remove the root file, or reinstall the plugin",
      );
    });
  });
});

describe("plugin manifest schema", () => {
  test("normalizes interface aliases, dependencies, user config, and channels", async () => {
    await withTempDir(async (root) => {
      const manifest = normalizePluginManifest(
        {
          name: "schema-plugin",
          dependencies: [
            "base-plugin@^1.2",
            "exact-plugin@=1.2.3",
            "tilde-plugin@~1.2.0",
            "range-plugin@>=2.0.0",
            { name: "team-plugin", marketplace: "team-marketplace" },
            { name: "object-versioned", marketplace: "team-marketplace", versionConstraint: "^2.0.0" },
            { name: "object-exact", version: "1.2.3" },
            { name: "local-plugin" },
          ],
          interface: {
            websiteURL: "urn:agenc:plugin:home",
            privacyPolicyURL: "urn:agenc:plugin:privacy",
            termsOfServiceURL: "urn:agenc:plugin:terms",
          },
          userConfig: {
            token: {
              type: "string",
              title: "Token",
              description: "Access token",
              required: true,
              default: "dev-token",
              sensitive: true,
            },
          },
          channels: [
            {
              server: "messages",
              displayName: "Messages",
              userConfig: {
                "room-id": {
                  type: "string",
                  title: "Room",
                  description: "Room identifier",
                },
              },
            },
          ],
          mcpServers: {
            typed: {
              type: "http",
              url: "urn:agenc:plugin:mcp",
            },
          },
        },
        root,
      );

      expect(manifest.dependencies).toEqual([
        "base-plugin@^1.2",
        "exact-plugin@=1.2.3",
        "tilde-plugin@~1.2.0",
        "range-plugin@>=2.0.0",
        "team-plugin@team-marketplace",
        "object-versioned@team-marketplace@^2.0.0",
        "object-exact@=1.2.3",
        "local-plugin",
      ]);
      expect(manifest.interface).toMatchObject({
        websiteUrl: "urn:agenc:plugin:home",
        privacyPolicyUrl: "urn:agenc:plugin:privacy",
        termsOfServiceUrl: "urn:agenc:plugin:terms",
      });
      expect(manifest.userConfig?.token).toMatchObject({
        type: "string",
        title: "Token",
        description: "Access token",
        required: true,
        default: "dev-token",
        sensitive: true,
      });
      expect(manifest.channels).toEqual([
        {
          server: "messages",
          displayName: "Messages",
          userConfig: {
            "room-id": {
              type: "string",
              title: "Room",
              description: "Room identifier",
            },
          },
        },
      ]);
      expect(manifest.mcpServers).toMatchObject({
        typed: {
          type: "http",
          url: "urn:agenc:plugin:mcp",
        },
      });
    });
  });

  test("rejects strict user config option violations", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          JSON.parse(`{
            "name": "bad-user-config",
            "userConfig": {
              "__proto__": {
                "type": "string",
                "title": "Unsafe",
                "description": "Unsafe key"
              },
              "1bad": {
                "type": "string",
                "title": "Bad key",
                "description": "Invalid identifier"
              },
              "unknown": {
                "type": "string",
                "title": "Unknown",
                "description": "Unknown field",
                "extra": true
              },
              "missing": {
                "type": "string",
                "title": "Missing description"
              },
              "badDefault": {
                "type": "string",
                "title": "Bad default",
                "description": "Invalid default",
                "default": { "value": "x" }
              },
              "badType": {
                "type": "secret",
                "title": "Bad type",
                "description": "Invalid type"
              }
            }
          }`),
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "userConfig",
          "userConfig.__proto__",
          "userConfig.1bad",
          "userConfig.unknown.extra",
          "userConfig.missing.description",
          "userConfig.badDefault.default",
          "userConfig.badType.type",
        ]),
      );
    });
  });

  test("rejects malformed channels and command metadata", async () => {
    await withTempDir(async (root) => {
      const channelIssues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-channels",
            channels: [
              { server: "ok", extra: true },
              { displayName: "Missing server" },
            ],
          },
          root,
        ),
      );
      const commandIssues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-commands",
            commands: {
              both: { source: "./commands/both.md", content: "inline" },
              neither: { description: "missing source/content" },
            },
          },
          root,
        ),
      );

      expect(channelIssues).toEqual(
        expect.arrayContaining([
          "channels[0].extra",
          "channels[1].server",
        ]),
      );
      expect(commandIssues).toEqual(
        expect.arrayContaining(["commands.both", "commands.neither"]),
      );
    });
  });

  test("rejects unsafe channel user config keys", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          JSON.parse(`{
            "name": "bad-channel-user-config",
            "channels": [
              {
                "server": "messages",
                "userConfig": {
                  "__proto__": {
                    "type": "string",
                    "title": "Unsafe",
                    "description": "Unsafe key"
                  }
                }
              }
            ]
          }`),
          root,
        ),
      );

      expect(issues).toContain("channels[0].userConfig.__proto__");
    });
  });

  test("rejects unsafe inline server map keys", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          JSON.parse(`{
            "name": "unsafe-server-maps",
            "mcpServers": {
              "__proto__": { "command": "node" },
              "valid": { "command": "node" }
            },
            "lspServers": [
              {
                "constructor": {
                  "command": "server",
                  "extensionToLanguage": { ".ts": "typescript" }
                }
              }
            ]
          }`),
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "mcpServers.__proto__",
          "lspServers[0].constructor",
        ]),
      );
    });
  });

  test("validates dependency reference syntax", async () => {
    await withTempDir(async (root) => {
      const manifest = normalizePluginManifest(
        {
          name: "dependencies",
          dependencies: [
            "base-plugin@^1.2",
            "qualified@team@^2",
            "exact-plugin@=1.2.3",
            "tilde-plugin@~1.2.0",
            "range-plugin@>=2.0.0",
            { name: "object-plugin", marketplace: "team_marketplace", versionConstraint: ">=2.1.0" },
            { name: "object-exact", version: "2.1.3" },
          ],
        },
        root,
      );
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-dependencies",
            dependencies: [
              "bad dep",
              { name: "../escape" },
              { name: "empty-marketplace", marketplace: "" },
              3,
              { name: "bad-version", versionConstraint: "1.2.3" },
              { name: "both-version-fields", version: "1.0.0", versionConstraint: "^1.0.0" },
            ],
          },
          root,
        ),
      );

      expect(manifest.dependencies).toEqual([
        "base-plugin@^1.2",
        "qualified@team@^2",
        "exact-plugin@=1.2.3",
        "tilde-plugin@~1.2.0",
        "range-plugin@>=2.0.0",
        "object-plugin@team_marketplace@>=2.1.0",
        "object-exact@=2.1.3",
      ]);
      expect(issues).toEqual(
        expect.arrayContaining([
          "dependencies[0]",
          "dependencies[1].name",
          "dependencies[2].marketplace",
          "dependencies[3]",
          "dependencies[4].versionConstraint",
          "dependencies[5].versionConstraint",
        ]),
      );
    });
  });

  test("rejects invalid names, homepage URLs, and manifest paths", async () => {
    await withTempDir(async (root) => {
      const missingNameIssues = manifestIssuePaths(() =>
        normalizePluginManifest({}, root),
      );
      const emptyNameIssues = manifestIssuePaths(() =>
        normalizePluginManifest({ name: "   " }, root),
      );
      const uppercaseNameIssues = manifestIssuePaths(() =>
        normalizePluginManifest({ name: "Foo" }, root),
      );
      const pathNameIssues = manifestIssuePaths(() =>
        normalizePluginManifest({ name: "foo/bar" }, root),
      );
      const bundleIssues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bundle-paths",
            mcpServers: ["./server.mcpb", "urn:agenc:plugin:mcp-bundle"],
          },
          root,
        ),
      );
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad name",
            homepage: "not-a-url",
            commands: {
              bad: { source: "../outside.md" },
            },
            agents: "./agents/readme.txt",
            outputStyles: "./styles/../outside",
            apps: "apps.json",
            hooks: "./hooks.txt",
            mcpServers: "./mcp.txt",
            lspServers: "../lsp.json",
          },
          root,
        ),
      );

      expect(missingNameIssues).toContain("name");
      expect(emptyNameIssues).toContain("name");
      expect(uppercaseNameIssues).toContain("name");
      expect(pathNameIssues).toContain("name");
      expect(bundleIssues).toEqual(
        expect.arrayContaining(["mcpServers[0]", "mcpServers[1]"]),
      );
      expect(issues).toEqual(
        expect.arrayContaining([
          "name",
          "homepage",
          "commands.bad.source",
          "agents",
          "outputStyles",
          "apps",
          "hooks",
          "mcpServers",
          "lspServers",
        ]),
      );
    });
  });

  test("rejects unknown top-level manifest fields", async () => {
    await withTempDir(async (root) => {
      expect(manifestIssuePaths(() =>
        normalizePluginManifest({ name: "closed", extra: true }, root),
      )).toContain("extra");
    });
  });

  test("rejects wrong-typed nested optional fields", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-nested-types",
            author: {
              name: "Team",
              email: 3,
              url: false,
            },
            commands: {
              bad: {
                content: "ok",
                description: 12,
                model: 4,
                allowedTools: ["Read", 2],
              },
            },
            interface: {
              displayName: 3,
              websiteURL: false,
              privacyPolicyUrl: 10,
              brandColor: 8,
            },
          },
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "author.email",
          "author.url",
          "commands.bad.description",
          "commands.bad.model",
          "commands.bad.allowedTools",
          "interface.displayName",
          "interface.websiteURL",
          "interface.privacyPolicyUrl",
          "interface.brandColor",
        ]),
      );
    });
  });

  test("rejects invalid inline hooks and server config shapes", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-inline-config",
            hooks: {
              Stop: [3],
            },
            mcpServers: {
              badArgs: { command: "node", args: ["ok", 3] },
              emptyCommand: { command: "" },
              badType: { type: "pipe", endpoint: "urn:agenc:plugin:mcp" },
              badTransport: {
                transport: "socket",
                endpoint: "urn:agenc:plugin:mcp",
              },
              stdioEndpointOnly: {
                transport: "stdio",
                endpoint: "urn:agenc:plugin:mcp",
              },
              remoteCommandOnly: {
                transport: "http",
                command: "node",
              },
              missingTarget: {},
            },
            lspServers: {
              missingExtensionMap: { command: "server" },
              badShape: {
                command: "",
                extensionToLanguage: { ts: "" },
                startupTimeout: 0,
                maxRestarts: -1,
              },
              spaceCommand: {
                command: "node server.js",
                extensionToLanguage: { ".js": "javascript" },
              },
              unsupportedFields: {
                command: "server",
                extensionToLanguage: { ".ts": "typescript" },
                transport: "socket",
                settings: {},
                shutdownTimeout: 100,
                restartOnCrash: true,
                extra: true,
              },
            },
          },
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "hooks",
          "mcpServers.badArgs.args",
          "mcpServers.emptyCommand.command",
          "mcpServers.badType.type",
          "mcpServers.badTransport.transport",
          "mcpServers.stdioEndpointOnly.command",
          "mcpServers.remoteCommandOnly.endpoint",
          "mcpServers.missingTarget",
          "lspServers.missingExtensionMap.extensionToLanguage",
          "lspServers.badShape.command",
          "lspServers.badShape.extensionToLanguage.ts",
          "lspServers.badShape.startupTimeout",
          "lspServers.badShape.maxRestarts",
          "lspServers.spaceCommand.command",
          "lspServers.unsupportedFields.transport",
          "lspServers.unsupportedFields.settings",
          "lspServers.unsupportedFields.shutdownTimeout",
          "lspServers.unsupportedFields.restartOnCrash",
          "lspServers.unsupportedFields.extra",
        ]),
      );
    });
  });

  test("rejects malformed interface asset declarations", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-interface-assets",
            interface: {
              composerIcon: 3,
              logo: "logo.png",
              screenshots: ["./screens/ok.png", 4, "../outside.png"],
            },
          },
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "interface.composerIcon",
          "interface.logo",
          "interface.screenshots[1]",
          "interface.screenshots[2]",
        ]),
      );
    });
  });

  test("rejects escaping server work directories inside inline arrays", async () => {
    await withTempDir(async (root) => {
      const issues = manifestIssuePaths(() =>
        normalizePluginManifest(
          {
            name: "bad-server-array-paths",
            mcpServers: [
              {
                local: {
                  command: "node",
                  cwd: "../outside",
                },
              },
            ],
            lspServers: [
              {
                ts: {
                  command: "server",
                  extensionToLanguage: { ".ts": "typescript" },
                  workspaceFolder: "../outside",
                },
              },
            ],
          },
          root,
        ),
      );

      expect(issues).toEqual(
        expect.arrayContaining([
          "mcpServers[0].local.cwd",
          "lspServers[0].ts.workspaceFolder",
        ]),
      );
    });
  });
});

describe("plugin loader", () => {
  test("does not activate auto-discovered local plugins when plugins.enabled is false", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(agencHome, "plugins", "toolbox"), {
        name: "toolbox",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: false, allowlist: [] } },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["toolbox"]);
      expect(result.errors).toEqual([]);
    });
  });

  test("does not activate configured plugin entries when plugins.enabled is false", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(workspaceRoot, "vendor", "toolbox");
      await writePluginManifest(pluginRoot, {
        name: "toolbox",
        hooks: "./missing-hooks.json",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: false,
            plugins: {
              toolbox: { enabled: true, path: "vendor/toolbox" },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["toolbox"]);
      expect(result.errors).toEqual([]);
    });
  });

  test("ignores array-shaped configured plugin entries", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(workspaceRoot, "vendor", "toolbox");
      await writePluginManifest(pluginRoot, {
        name: "toolbox",
      });
      const spoofedEntry = Object.assign(["spoof"], {
        path: "vendor/toolbox",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              toolbox: spoofedEntry as never,
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  test("does not let array-shaped configured plugin entries disable discovered plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(agencHome, "plugins", "toolbox"), {
        name: "toolbox",
      });
      const spoofedEntry = Object.assign(["spoof"], {
        enabled: false,
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              toolbox: spoofedEntry as never,
            },
          },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual(["toolbox"]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  test("discovers configured plugin dirs only when plugins.enabled is true", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(workspaceRoot, "vendor", "plugins", "toolbox"), {
        name: "toolbox",
      });
      await mkdir(join(workspaceRoot, "vendor", "plugins", "skills"), {
        recursive: true,
      });

      const disabled = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: false, dirs: ["vendor/plugins"] } },
      });
      const enabled = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true, dirs: ["vendor/plugins"] } },
      });

      expect(disabled.enabled).toEqual([]);
      expect(disabled.disabled.map((plugin) => plugin.name)).toEqual(["toolbox"]);
      expect(enabled.enabled.map((plugin) => plugin.name)).toEqual(["toolbox"]);
    });
  });

  test("uses only canonical plugins.plugins entries for enablement overrides", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(agencHome, "plugins", "alpha"), { name: "alpha" });
      await writePluginManifest(join(agencHome, "plugins", "beta"), { name: "beta" });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              alpha: { enabled: true },
            },
          },
        },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual(["alpha", "beta"]);
      expect(result.disabled).toEqual([]);
    });
  });

  test("loads components and uses manifest.settings as the sole package-default authority", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "toolbox");
      await writePluginManifest(pluginRoot, {
        name: "toolbox",
        version: "1.0.0",
        apps: "./config/apps.json",
        hooks: "./hooks/hooks.json",
        mcpServers: {
          local: {
            command: "node",
            args: ["server.js"],
            cwd: "bin",
          },
        },
        lspServers: "./.lsp.json",
        settings: { options: { fromManifest: true }, unsupported: true },
      });
      await writeFileAt(join(pluginRoot, "skills", "planner", "SKILL.md"), "---\nname: planner\n---\n");
      await writeFileAt(join(pluginRoot, "commands", "build.md"), "# build\n");
      await writeFileAt(join(pluginRoot, "agents", "review.md"), "# review\n");
      await writeFileAt(join(pluginRoot, "output-styles", "plain.md"), "# plain\n");
      await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
        hooks: {
          Stop: [{ matcher: "done", hooks: [{ type: "command", command: "true" }] }],
        },
      });
      await writeJson(join(pluginRoot, ".lsp.json"), {
        lspServers: {
          ts: {
            command: "typescript-language-server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: "workspace",
          },
        },
      });
      await writeJson(join(pluginRoot, "config", "apps.json"), {
        apps: {
          calendar: { id: "calendar" },
        },
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      const plugin = result.enabled[0];

      expect(result.errors).toEqual([]);
      expect(plugin?.name).toBe("toolbox");
      expect(plugin?.commands.map((command) => command.name)).toEqual(["build"]);
      expect(plugin?.skillsPaths).toEqual([join(pluginRoot, "skills")]);
      expect(plugin?.agentsPaths).toEqual([join(pluginRoot, "agents")]);
      expect(plugin?.outputStylesPaths).toEqual([join(pluginRoot, "output-styles")]);
      expect(plugin?.hookSources).toHaveLength(1);
      expect(plugin?.mcpServers.local?.cwd).toBe(join(pluginRoot, "bin"));
      expect(plugin?.lspServers.ts?.workspaceFolder).toBe(join(pluginRoot, "workspace"));
      expect(plugin?.appConnectorIds).toEqual(["calendar"]);
      expect(plugin?.settings).toEqual({
        options: { fromManifest: true },
      });
    });
  });

  test("applies configured MCP server overlays to plugin MCP servers", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "toolbox");
      await writePluginManifest(pluginRoot, {
        name: "toolbox",
        mcpServers: {
          local: { command: "node" },
          disabled: { command: "node" },
          locked: { command: "node" },
          passthrough: { command: "node" },
        },
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              toolbox: {
                mcp_servers: {
                  local: {
                    default_tools_approval_mode: "on-request",
                    enabled_tools: ["read"],
                    disabled_tools: ["write"],
                    tools: {
                      read: { default_permission_mode: "never" },
                    },
                  },
                  disabled: { enabled: false },
                  locked: { enabled_tools: [] },
                },
              },
            },
          },
        },
      });
      const plugin = result.enabled[0];

      expect(result.errors).toEqual([]);
      expect(Object.keys(plugin?.mcpServers ?? {}).sort()).toEqual(["local", "locked", "passthrough"]);
      expect(plugin?.mcpServers.local).toMatchObject({
        command: "node",
        default_tools_approval_mode: "on-request",
        enabled_tools: ["read"],
        disabled_tools: ["write"],
        tools: {
          read: { default_permission_mode: "never" },
        },
      });
      expect(plugin?.mcpServers.locked?.enabled_tools).toEqual([]);
    });
  });

  test("accepts websocket plugin MCP transports", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "socket-tools");
      await writePluginManifest(pluginRoot, {
        name: "socket-tools",
        mcpServers: {
          websocket: {
            transport: "websocket",
            endpoint: "ws://127.0.0.1:4100/mcp",
          },
          alias: {
            type: "ws",
            url: "ws://127.0.0.1:4101/mcp",
          },
          inferredWebsocket: {
            endpoint: "wss://127.0.0.1:4102/mcp",
          },
          inferredHttp: {
            endpoint: "https://127.0.0.1:4103/mcp",
          },
        },
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      const plugin = result.enabled[0];

      expect(result.errors).toEqual([]);
      expect(plugin?.mcpServers.websocket).toMatchObject({
        transport: "websocket",
        endpoint: "ws://127.0.0.1:4100/mcp",
      });
      expect(plugin?.mcpServers.alias).toMatchObject({
        transport: "websocket",
        endpoint: "ws://127.0.0.1:4101/mcp",
      });
      expect(plugin?.mcpServers.inferredWebsocket).toMatchObject({
        transport: "websocket",
        endpoint: "wss://127.0.0.1:4102/mcp",
      });
      expect(plugin?.mcpServers.inferredHttp).toMatchObject({
        transport: "http",
        endpoint: "https://127.0.0.1:4103/mcp",
      });
    });
  });

  test("matches plugins.allowlist against canonical manifest names", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(agencHome, "plugins", "alpha-dir"), {
        name: "alpha",
      });
      await writePluginManifest(join(agencHome, "plugins", "beta-dir"), {
        name: "beta",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true, allowlist: ["alpha"] } },
      });

      expect(result.enabled.map((plugin) => plugin.name)).toEqual(["alpha"]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["beta"]);

      const unfiltered = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true, allowlist: [] } },
      });

      expect(unfiltered.enabled.map((plugin) => plugin.name)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(unfiltered.disabled).toEqual([]);
    });
  });

  test("matches marketplace plugin ids and their unqualified names", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(pluginStorageRoot, "installed-foo");
      await writePluginManifest(pluginRoot, { name: "foo" });
      await writeJson(
        join(pluginRoot, ".agenc-plugin", "agenc-install.json"),
        { dependencyIdentity: "foo@team" },
      );

      for (const allowedId of ["foo@team", "foo"]) {
        const result = await loadPlugins({
          pluginStorageRoot,
          workspaceRoot,
          config: { plugins: { enabled: true, allowlist: [allowedId] } },
        });

        expect(result.enabled.map((plugin) => plugin.id)).toEqual([
          "foo@team",
        ]);
        expect(result.disabled).toEqual([]);
      }
    });
  });

  test("does not authorize plugins through directory, source, or config-key aliases", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      const storagePlugin = join(pluginStorageRoot, "directory-alias");
      const configuredPlugin = join(workspaceRoot, "vendor", "configured");
      await writePluginManifest(storagePlugin, { name: "storage-manifest" });
      await writePluginManifest(configuredPlugin, {
        name: "configured-manifest",
      });

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            allowlist: [
              "directory-alias",
              await realpath(storagePlugin),
              "configured-alias",
            ],
            plugins: {
              "configured-alias": {
                enabled: true,
                path: "vendor/configured",
              },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name).sort()).toEqual([
        "configured-manifest",
        "storage-manifest",
      ]);
    });
  });

  test("filters manifest settings and rejects a root settings.json", async () => {
    await withTempDir(async (root) => {
      const manifestOnly = join(root, "plugins", "manifest-settings");
      await writePluginManifest(manifestOnly, {
        name: "manifest-settings",
        settings: {
          options: { enabled: true },
          unknown: true,
        },
      });
      const badSettings = join(root, "plugins", "bad-settings");
      await writePluginManifest(badSettings, { name: "bad-settings" });
      await writeFileAt(join(badSettings, "settings.json"), "{ bad json");

      const manifestResult = await createPluginFromPath(manifestOnly, {
        source: "test",
        enabled: true,
      });
      const badResult = await createPluginFromPath(badSettings, {
        source: "test",
        enabled: true,
      });

      expect(manifestResult.plugin?.settings).toEqual({
        options: { enabled: true },
      });
      expect(badResult.plugin?.enabled).toBe(false);
      expect(badResult.plugin?.settings).toBeUndefined();
      expect(badResult.errors.map((error) => error.message)).toEqual([
        expect.stringContaining("Retired plugin settings file detected"),
      ]);
    });
  });

  test("keeps invalid plugin paths non-fatal", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "broken");
      await writePluginManifest(pluginRoot, {
        name: "broken",
        commands: "./missing.md",
        hooks: "./missing-hooks.json",
        mcpServers: "./missing-mcp.json",
      });

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin?.name).toBe("broken");
      expect(plugin?.enabled).toBe(true);
      expect(errors.map((error) => error.type).sort()).toEqual([
        "hooks",
        "mcp",
        "path-not-found",
      ]);
    });
  });

  test("rejects malformed canonical manifests and reports the real manifest path", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-json");
      await writeFileAt(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        "{ invalid json",
      );
      await writeFileAt(join(pluginRoot, "commands", "ghost.md"), "# ghost\n");

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin).toBeNull();
      expect(errors).toMatchObject([
        {
          type: "manifest",
          path: join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        },
      ]);
    });
  });

  test("reports missing configured roots without enabling phantom plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            plugins: {
              missing: { path: "vendor/missing" },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toMatchObject([
        { type: "path-not-found", plugin: "missing" },
      ]);
    });
  });

  test("does not read component files for disabled configured plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(workspaceRoot, "vendor", "disabled");
      await writePluginManifest(pluginRoot, {
        name: "disabled",
        hooks: "./missing-hooks.json",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            plugins: {
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["disabled"]);
      expect(result.errors).toEqual([]);
    });
  });

  test("rejects unsafe server keys and working directories", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "server-safety");
      await writePluginManifest(pluginRoot, {
        name: "server-safety",
        mcpServers: "./config/mcp.json",
        lspServers: "./.lsp.json",
      });
      await writeFileAt(
        join(pluginRoot, "config", "mcp.json"),
        `{
  "mcpServers": {
    "__proto__": { "command": "node" },
    "constructor": { "command": "node" },
    "valid": { "command": "node", "cwd": "bin" },
    "escape": { "command": "node", "cwd": "../outside" },
    "absolute": { "command": "node", "cwd": ${JSON.stringify(join(root, "outside"))} }
  }
}
`,
      );
      await writeJson(join(pluginRoot, ".lsp.json"), {
        lspServers: {
          prototype: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
          },
          ts: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: "../outside",
          },
          absolute: {
            command: "server",
            extensionToLanguage: { ".js": "javascript" },
            workspaceFolder: join(root, "outside"),
          },
        },
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      const plugin = result.enabled[0];

      expect(Object.getPrototypeOf(plugin?.mcpServers)).toBeNull();
      expect(plugin?.mcpServers.valid?.cwd).toBe(join(pluginRoot, "bin"));
      expect(Object.keys(plugin?.mcpServers ?? {})).toEqual(["valid"]);
      expect(Object.keys(plugin?.lspServers ?? {})).toEqual([]);
      expect(result.errors.map((error) => error.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Unsafe mcp server key"),
          expect.stringContaining("Unsafe lsp server key"),
          expect.stringContaining("path must be normalized"),
          expect.stringContaining("path must be relative to the plugin root"),
        ]),
      );
    });
  });

  test("disables auto-discovered plugins by manifest name", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "directory-name");
      await writePluginManifest(pluginRoot, {
        name: "manifest-name",
        hooks: "./missing-hooks.json",
      });

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              "manifest-name": { enabled: false },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["manifest-name"]);
      expect(result.errors).toEqual([]);
    });
  });

  test("loads command map content and metadata sources", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "mapped-commands");
      await writePluginManifest(pluginRoot, {
        name: "mapped-commands",
        commands: {
          inline: { content: "Inline command", description: "Inline" },
          file: { source: "./commands/file.md", argumentHint: "<topic>" },
        },
      });
      await writeFileAt(join(pluginRoot, "commands", "file.md"), "# file\n");

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(errors).toEqual([]);
      expect(plugin?.commands.map((command) => command.name)).toEqual(["file", "inline"]);
      expect(plugin?.commands.find((command) => command.name === "inline")?.content)
        .toBe("Inline command");
      expect(plugin?.commands.find((command) => command.name === "file")?.metadata.argumentHint)
        .toBe("<topic>");
    });
  });

  test("rejects unsafe command and settings keys", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "unsafe-manifest");
      await writeFileAt(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        `{
  "name": "unsafe-manifest",
  "commands": {
    "__proto__": { "content": "bad" }
  },
  "settings": {
    "constructor": true
  },
  "userConfig": {
    "prototype": true
  }
}
`,
      );

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin).toBeNull();
      expect(errors.map((error) => error.message)).toContain(
        "Plugin manifest failed validation",
      );
    });
  });

  test("rejects unsafe hook event keys", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "hook-safety");
      await writePluginManifest(pluginRoot, {
        name: "hook-safety",
        hooks: "./hooks/hooks.json",
      });
      await writeFileAt(
        join(pluginRoot, "hooks", "hooks.json"),
        `{
  "hooks": {
    "__proto__": [{ "hooks": [{ "type": "command", "command": "true" }] }]
  }
}
`,
      );

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(Object.getPrototypeOf(plugin?.hookSources)).toBe(Array.prototype);
      expect(plugin?.hookSources).toEqual([]);
      expect(errors.map((error) => error.message)).toContain(
        "Hook map contains an unsafe key or invalid matcher list",
      );
    });
  });

  test("rejects malformed hook matcher entries", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-hooks");
      await writePluginManifest(pluginRoot, {
        name: "bad-hooks",
        hooks: {
          Stop: [3],
        },
      });

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin).toBeNull();
      expect(errors.map((error) => error.message)).toContain(
        "Plugin manifest failed validation",
      );
    });
  });

  test("uses the canonical manifest path for inline hook diagnostics", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "root-hooks");
      await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), {
        name: "root-hooks",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      });

      const { plugin } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin?.hookSources[0]?.sourcePath).toBe(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
      );
      expect(plugin?.hookSources[0]?.sourceRelativePath).toBe(
        `${PLUGIN_MANIFEST_RELATIVE_PATH}#hooks[0]`,
      );
    });
  });

  test("bounds default command discovery", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "many-commands");
      await writePluginManifest(pluginRoot, { name: "many-commands" });
      for (let index = 0; index < 520; index += 1) {
        await writeFileAt(join(pluginRoot, "commands", `cmd-${index}.md`), "# command\n");
      }
      await writeFileAt(
        join(pluginRoot, "commands", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "deep.md"),
        "# deep\n",
      );

      const { plugin } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
      });

      expect(plugin?.commands).toHaveLength(512);
      expect(plugin?.commands.map((command) => command.name)).not.toContain("deep");
    });
  });

  test("discovers user, workspace, and configured plugin roots", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const userPlugin = join(agencHome, "plugins", "user");
      const workspacePlugin = join(workspaceRoot, ".agents", "plugins", "workspace");
      const workspacePluginsDirPlugin = join(workspaceRoot, "plugins", "workspace-plugins");
      const configuredPlugin = join(workspaceRoot, "vendor", "configured");
      const disabledPlugin = join(workspaceRoot, "vendor", "disabled");
      for (const [name, pluginRoot] of [
        ["user", userPlugin],
        ["workspace", workspacePlugin],
        ["workspace-plugins", workspacePluginsDirPlugin],
        ["configured", configuredPlugin],
        ["disabled", disabledPlugin],
      ] as const) {
        await writePluginManifest(pluginRoot, { name });
        await writeFileAt(join(pluginRoot, "skills", name, "SKILL.md"), "---\nname: x\n---\n");
      }

      const roots = await discoverPluginRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              configured: { path: "vendor/configured" },
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });
      const skillRoots = await discoverPluginSkillRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            plugins: {
              configured: { path: "vendor/configured" },
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });

      const expectedRoots = await Promise.all([
        realpath(configuredPlugin),
        realpath(disabledPlugin),
        realpath(userPlugin),
        realpath(workspacePlugin),
        realpath(workspacePluginsDirPlugin),
      ]);
      expect(roots.map((entry) => entry.path).sort()).toEqual(expectedRoots.sort());
      const expectedSkillRoots = await Promise.all([
        realpath(join(configuredPlugin, "skills")),
        realpath(join(userPlugin, "skills")),
        realpath(join(workspacePlugin, "skills")),
        realpath(join(workspacePluginsDirPlugin, "skills")),
      ]);
      expect(skillRoots.sort()).toEqual(expectedSkillRoots.sort());
    });
  });

  test("fails closed when user and project plugins share one canonical ID", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      const userPlugin = join(pluginStorageRoot, "user-copy");
      const projectPlugin = join(
        workspaceRoot,
        ".agents",
        "plugins",
        "project-copy",
      );
      for (const pluginRoot of [userPlugin, projectPlugin]) {
        await writePluginManifest(pluginRoot, { name: "shared-identity" });
        await writeFileAt(
          join(pluginRoot, "commands", "inspect.md"),
          "# inspect\n",
        );
      }

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toHaveLength(2);
      expect(result.disabled.map((plugin) => plugin.id)).toEqual([
        "shared-identity",
        "shared-identity",
      ]);
      expect(result.disabled.every((plugin) => plugin.commands.length === 1))
        .toBe(true);
      const identityErrors = result.errors.filter((issue) =>
        issue.message.includes("Duplicate canonical plugin ID")
      );
      expect(identityErrors).toHaveLength(2);
      for (const issue of identityErrors) {
        expect(issue.message).toContain(await realpath(userPlugin));
        expect(issue.message).toContain(await realpath(projectPlugin));
        expect(issue.message).toContain("No copy was activated");
      }
    });
  });

  test("rejects case-variant manifest names before plugin registration", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      await writePluginManifest(join(pluginStorageRoot, "uppercase"), {
        name: "Foo",
      });
      await writePluginManifest(
        join(workspaceRoot, ".agents", "plugins", "lowercase"),
        { name: "foo" },
      );

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(result.enabled.map((plugin) => plugin.id)).toEqual(["foo"]);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "manifest",
          message: expect.stringContaining("Plugin manifest failed validation"),
        }),
      ]));
    });
  });

  test("fails closed when old data cannot identify one canonical plugin", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      const qualified = join(pluginStorageRoot, "qualified");
      const hyphenated = join(pluginStorageRoot, "hyphenated");
      await writePluginManifest(qualified, { name: "foo" });
      await writeJson(
        join(qualified, ".agenc-plugin", "agenc-install.json"),
        { dependencyIdentity: "foo@bar" },
      );
      await writePluginManifest(hyphenated, { name: "foo-bar" });
      await writeFileAt(
        join(pluginStorageRoot, "data", "foo-bar", "state.json"),
        "ambiguous",
      );

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.id).sort()).toEqual([
        "foo-bar",
        "foo@bar",
      ]);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "settings",
          message: expect.stringContaining("cannot be attributed safely"),
        }),
      ]));
    });
  });

  test("blocks commands, hooks, and MCP from duplicate configured plugin IDs", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "home", "plugins");
      const workspaceRoot = join(root, "workspace");
      const configuredDirA = join(root, "configured-a");
      const configuredDirB = join(root, "configured-b");
      const configuredA = join(configuredDirA, "copy-a");
      const configuredB = join(configuredDirB, "copy-b");
      for (const pluginRoot of [configuredA, configuredB]) {
        await writePluginManifest(pluginRoot, {
          name: "shared-runtime",
          hooks: "./hooks/hooks.json",
          mcpServers: {
            local: { command: "node", args: ["server.mjs"] },
          },
        });
        await writeFileAt(
          join(pluginRoot, "commands", "inspect.md"),
          "# inspect\n",
        );
        await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
          hooks: {
            Stop: [{
              matcher: "done",
              hooks: [{ type: "command", command: "true" }],
            }],
          },
        });
      }

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: {
          plugins: {
            enabled: true,
            dirs: [configuredDirA, configuredDirB],
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toHaveLength(2);
      for (const plugin of result.disabled) {
        expect(plugin.id).toBe("shared-runtime");
        expect(plugin.commands).toHaveLength(1);
        expect(plugin.hookSources).toHaveLength(1);
        expect(Object.keys(plugin.mcpServers)).toEqual(["local"]);
        expect(plugin.errors.some((issue) =>
          issue.message.includes("Duplicate canonical plugin ID")
        )).toBe(true);
      }
    });
  });

  test("discovers workspace plugins from the git root when running in a subdirectory", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const gitRoot = join(root, "repo");
      const workspaceRoot = join(gitRoot, "runtime");
      const repoPlugin = join(gitRoot, "plugins", "zeroday-hunter");
      await mkdir(join(gitRoot, ".git"), { recursive: true });
      await mkdir(workspaceRoot, { recursive: true });
      await writePluginManifest(repoPlugin, { name: "zeroday-hunter" });
      await writeFileAt(join(repoPlugin, "skills", "zeroday-hunter", "SKILL.md"), "---\nname: x\n---\n");

      const roots = await discoverPluginRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      const skillRoots = await discoverPluginSkillRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(roots.map((entry) => entry.path)).toContain(await realpath(repoPlugin));
      expect(skillRoots).toContain(await realpath(join(repoPlugin, "skills")));
    });
  });

  test("discovers workspace plugins from a git worktree root", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const gitRoot = join(root, "repo");
      const workspaceRoot = join(gitRoot, "runtime");
      const repoPlugin = join(gitRoot, "plugins", "zeroday-hunter");
      await writeFileAt(join(gitRoot, ".git"), "gitdir: /tmp/fake-gitdir\n");
      await mkdir(workspaceRoot, { recursive: true });
      await writePluginManifest(repoPlugin, { name: "zeroday-hunter" });
      await writeFileAt(join(repoPlugin, "skills", "zeroday-hunter", "SKILL.md"), "---\nname: x\n---\n");

      const roots = await discoverPluginRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });
      const skillRoots = await discoverPluginSkillRoots({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(roots.map((entry) => entry.path)).toContain(await realpath(repoPlugin));
      expect(skillRoots).toContain(await realpath(join(repoPlugin, "skills")));
    });
  });

  test("discovers plugins only when each has a canonical manifest", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const appPlugin = join(workspaceRoot, ".agents", "plugins", "app-only");
      const stylePlugin = join(agencHome, "plugins", "style-only");
      await writePluginManifest(appPlugin, {
        name: "app-only",
        apps: "./.app.json",
      });
      await writePluginManifest(stylePlugin, { name: "style-only" });
      await writeJson(join(appPlugin, ".app.json"), {
        apps: { calendar: { id: "calendar" } },
      });
      await writeFileAt(join(stylePlugin, "output-styles", "plain.md"), "# plain\n");

      const result = await loadPlugins({
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(result.enabled.map((plugin) => plugin.name).sort()).toEqual([
        "app-only",
        "style-only",
      ]);
      expect(result.enabled.find((plugin) => plugin.name === "app-only")?.appConnectorIds)
        .toEqual([]);
      expect(result.enabled.find((plugin) => plugin.name === "app-only")?.contentProvenance)
        .toBe("repository-controlled");
      expect(result.enabled.find((plugin) => plugin.name === "style-only")?.outputStylesPaths)
        .toEqual([join(stylePlugin, "output-styles")]);
    });
  });

  test("never treats known plugin containers as plugins", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "plugin-storage");
      const workspaceRoot = join(root, "workspace");
      const storagePlugin = join(pluginStorageRoot, "storage-normal");
      const agentPlugin = join(
        workspaceRoot,
        ".agents",
        "plugins",
        "agent-normal",
      );
      const workspacePlugin = join(
        workspaceRoot,
        "plugins",
        "workspace-normal",
      );
      await mkdir(join(pluginStorageRoot, "skills"), { recursive: true });
      await mkdir(join(workspaceRoot, ".agents", "plugins", "skills"), {
        recursive: true,
      });
      await mkdir(join(workspaceRoot, "plugins", "skills"), {
        recursive: true,
      });
      await writePluginManifest(storagePlugin, { name: "storage-normal" });
      await writePluginManifest(agentPlugin, { name: "agent-normal" });
      await writePluginManifest(workspacePlugin, { name: "workspace-normal" });

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
      });

      expect(result.enabled.map(plugin => plugin.name).sort()).toEqual([
        "agent-normal",
        "storage-normal",
        "workspace-normal",
      ]);
      expect(result.enabled.map(plugin => plugin.root)).toEqual(
        expect.arrayContaining(await Promise.all([
          realpath(storagePlugin),
          realpath(agentPlugin),
          realpath(workspacePlugin),
        ])),
      );
    });
  });
});

describe("plugin directories", () => {
  test("uses one explicit plugin storage root", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "plugin-storage");

      expect(getPluginsDirectory(pluginStorageRoot)).toBe(pluginStorageRoot);
    });
  });

  test("uses the explicit storage authority for sanitized plugin data", async () => {
    await withTempDir(async (root) => {
      const pluginStorageRoot = join(root, "plugin-storage");

      expect(getPluginsDirectory(pluginStorageRoot)).toBe(pluginStorageRoot);
      expect(sanitizePluginId("team/plugin@1")).toBe("team-plugin-1");
      expect(pluginFilesystemKey("foo@bar")).not.toBe(
        pluginFilesystemKey("foo-bar"),
      );

      const dataDir = getPluginDataDir("team/plugin@1", pluginStorageRoot);
      await writeFileAt(join(dataDir, "state.json"), "{}");

      await expect(
        getPluginDataDirSize("team/plugin@1", pluginStorageRoot),
      ).resolves.toMatchObject({ bytes: 2 });
      await deletePluginDataDir("team/plugin@1", pluginStorageRoot);
      await expect(
        getPluginDataDirSize("team/plugin@1", pluginStorageRoot),
      ).resolves.toBeNull();

      const marketplaceQualified = getPluginDataDir("foo@bar", pluginStorageRoot);
      const hyphenated = getPluginDataDir("foo-bar", pluginStorageRoot);
      expect(marketplaceQualified).not.toBe(hyphenated);
      await writeFileAt(join(marketplaceQualified, "state.json"), "qualified");
      await writeFileAt(join(hyphenated, "state.json"), "hyphenated");
      await deletePluginDataDir("foo@bar", pluginStorageRoot);
      await expect(getPluginDataDirSize("foo-bar", pluginStorageRoot))
        .resolves.toMatchObject({ bytes: 10 });
    });
  });
});

describe("plugin validation", () => {
  test("rejects malformed markdown component metadata", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-metadata");
      await writePluginManifest(pluginRoot, { name: "bad-metadata" });
      await writeFileAt(
        join(pluginRoot, "skills", "broken", "SKILL.md"),
        "---\ndescription: 12\nallowed-tools: [Read, 3]\nunknown-field: true\n---\nBody\n",
      );

      const results = await validatePluginContents(pluginRoot);
      const skillResult = results.find((result) => result.fileType === "skill");

      expect(skillResult?.success).toBe(false);
      expect(skillResult?.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining(["description", "allowed-tools"]),
      );
      expect(skillResult?.warnings.map((warning) => warning.path)).toContain("unknown-field");
    });
  });

  test("validates path-bearing manifest fields", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-paths");
      await writePluginManifest(pluginRoot, {
        name: "bad-paths",
        commands: {
          bad: { source: "../outside.md" },
        },
        outputStyles: "./styles/../outside",
        apps: "apps.json",
        hooks: "../hooks.json",
        mcpServers: "./mcp/../servers.json",
        lspServers: "../lsp.json",
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "commands.bad.source",
          "outputStyles",
          "apps",
          "hooks",
          "mcpServers",
          "lspServers",
        ]),
      );
    });
  });

  test("rejects malformed optional manifest fields", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-fields");
      await writePluginManifest(pluginRoot, {
        name: "bad-fields",
        version: 12,
        keywords: ["ok", 3],
        settings: "bad",
        interface: {
          capabilities: ["ok", 4],
        },
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "version",
          "keywords",
          "settings",
          "interface.capabilities",
        ]),
      );
    });
  });

  test("caps JSON plugin file reads", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "huge");
      await writeFileAt(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        JSON.stringify({ name: "huge", description: "x".repeat(1_100_000) }),
      );

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n"))
        .toContain("too large");
    });
  });

  test("validates inline and external server working directories", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-server-paths");
      await writePluginManifest(pluginRoot, {
        name: "bad-server-paths",
        mcpServers: [
          {
            inline: { command: "node", cwd: "../outside" },
          },
        ],
        lspServers: "./lsp.json",
      });
      await writeJson(join(pluginRoot, "lsp.json"), {
        lspServers: {
          ts: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: join(root, "outside"),
          },
        },
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "mcpServers[0].inline.cwd",
          "lspServers.ts.workspaceFolder",
        ]),
      );
    });
  });

  test("allows normalized in-root filenames that contain double dots", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "dots");
      await writePluginManifest(pluginRoot, {
        name: "dots",
        commands: "./commands/v1..v2.md",
      });
      await writeFileAt(join(pluginRoot, "commands", "v1..v2.md"), "# ok\n");

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(true);
    });
  });

  test("validates nested plugin skills", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "nested-skill");
      await writePluginManifest(pluginRoot, { name: "nested-skill" });
      await writeFileAt(
        join(pluginRoot, "skills", "a", "b", "SKILL.md"),
        "---\ndescription: 10\n---\nBody\n",
      );

      const results = await validatePluginContents(pluginRoot);

      expect(results.find((result) => result.filePath.endsWith("skills/a/b/SKILL.md"))?.success)
        .toBe(false);
    });
  });

  test("bounds markdown component validation scans", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "many-components");
      await writePluginManifest(pluginRoot, { name: "many-components" });
      for (let index = 0; index < 520; index += 1) {
        await writeFileAt(join(pluginRoot, "commands", `cmd-${index}.md`), "# command\n");
      }
      await writeFileAt(
        join(pluginRoot, "commands", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "deep.md"),
        "# deep\n",
      );

      const results = await validatePluginContents(pluginRoot);
      const commandFiles = results
        .filter((result) => result.fileType === "command")
        .map((result) => result.filePath);

      expect(commandFiles).toHaveLength(512);
      expect(commandFiles.some((file) => file.endsWith("deep.md"))).toBe(false);
    });
  });
});

function manifestIssuePaths(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestError);
    return (error as PluginManifestError).issues.map((issue) => issue.path);
  }
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "agenc-plugin-test-")),
  );
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), manifest);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}
