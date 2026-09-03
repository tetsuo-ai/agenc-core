import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  assertConfigPatchAuthority,
  configAuthorityClass,
  MANAGED_ONLY_CONFIG_KEYS,
  OPERATOR_ONLY_CONFIG_KEYS,
  OPERATOR_ONLY_CONFIG_PATHS,
  REPOSITORY_MONOTONIC_CONFIG_KEYS,
  type ManagedOnlyConfigKey,
  type OperatorOnlyConfigKey,
} from "../../src/config/layer-authority.js";
import {
  loadLayeredConfig,
  mergeConfigLayerSnapshots,
  type ConfigLayerSnapshot,
} from "../../src/config/repository.js";
import { serializeConfigToml } from "../../src/config/serialize.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "agenc-layer-authority-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function writeConfig(path: string, config: Readonly<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    serializeConfigToml({ config_version: 2, ...config }),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function repositoryOptions(root: string): {
  readonly env: { readonly AGENC_HOME: string };
  readonly projectRoot: string;
  readonly managedConfigPath: string;
  readonly managedDropInDir: string;
  readonly projectTrusted: true;
} {
  return {
    env: { AGENC_HOME: join(root, "home") },
    projectRoot: join(root, "project"),
    managedConfigPath: join(root, "missing-managed.toml"),
    managedDropInDir: join(root, "missing-managed.d"),
    projectTrusted: true,
  };
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const MANAGED_VALUES = {
  availableModels: ["grok-4.6"],
  allowManagedHooksOnly: true,
  allowManagedPermissionRulesOnly: true,
  allowManagedMcpServersOnly: true,
  strictPluginOnlyCustomization: ["skills", "hooks"],
  strictKnownMarketplaces: [{ source: "github", repo: "org/plugins" }],
  blockedMarketplaces: [{ source: "hostPattern", hostPattern: "^bad\\.example$" }],
  forceLoginOrgUUID: "org-id",
  skipWebFetchPreflight: true,
  agencMdExcludes: ["**/vendor/**"],
  pluginTrustMessage: "Approved sources only.",
} as const satisfies Record<ManagedOnlyConfigKey, unknown>;

const OPERATOR_VALUES = {
  gateway: { defaultAgent: "operator", hooks: { enabled: false } },
  modelOverrides: { "grok-4.6": "grok-4.6-enterprise" },
  allowedMcpServers: [{ serverName: "internal" }],
  allowedHttpHookUrls: ["https://hooks.example/*"],
  httpHookAllowedEnvVars: ["HOOK_TOKEN"],
  minimumVersion: "0.17.0",
} as const satisfies Record<OperatorOnlyConfigKey, unknown>;

describe("canonical config layer authority", () => {
  test("keeps the three registries exact, disjoint, and classified", () => {
    expect(MANAGED_ONLY_CONFIG_KEYS).toEqual([
      "availableModels",
      "allowManagedHooksOnly",
      "allowManagedPermissionRulesOnly",
      "allowManagedMcpServersOnly",
      "strictPluginOnlyCustomization",
      "strictKnownMarketplaces",
      "blockedMarketplaces",
      "forceLoginOrgUUID",
      "skipWebFetchPreflight",
      "agencMdExcludes",
      "pluginTrustMessage",
    ]);
    expect(OPERATOR_ONLY_CONFIG_KEYS).toEqual([
      "gateway",
      "modelOverrides",
      "allowedMcpServers",
      "allowedHttpHookUrls",
      "httpHookAllowedEnvVars",
      "minimumVersion",
    ]);
    expect(OPERATOR_ONLY_CONFIG_PATHS).toEqual([["tui", "keybindings"]]);
    expect(REPOSITORY_MONOTONIC_CONFIG_KEYS).toEqual([
      "deniedMcpServers",
      "disableAllHooks",
      "disableAutoMode",
    ]);
    const all = [
      ...MANAGED_ONLY_CONFIG_KEYS,
      ...OPERATOR_ONLY_CONFIG_KEYS,
      ...REPOSITORY_MONOTONIC_CONFIG_KEYS,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const key of MANAGED_ONLY_CONFIG_KEYS) {
      expect(configAuthorityClass(key)).toBe("managed-only");
    }
    for (const key of OPERATOR_ONLY_CONFIG_KEYS) {
      expect(configAuthorityClass(key)).toBe("operator-only");
    }
    for (const key of REPOSITORY_MONOTONIC_CONFIG_KEYS) {
      expect(configAuthorityClass(key)).toBe("repository-monotonic");
    }
  });

  test.each(Object.entries(MANAGED_VALUES))(
    "rejects CLI synthesis of managed-only key %s",
    async (key, value) => {
      const root = temporaryRoot();
      await expect(loadLayeredConfig({
        ...repositoryOptions(root),
        cliOverrides: { [key]: value } as AgenCConfig,
      })).rejects.toMatchObject({
        code: "invalid-source",
        message: expect.stringContaining(`managed-only key ${key}`),
      });
    },
  );

  test("strips plugin defaults and applies the same fields only from managed TOML", async () => {
    const pluginRoot = temporaryRoot();
    const plugin = await loadLayeredConfig({
      ...repositoryOptions(pluginRoot),
      pluginDefaults: MANAGED_VALUES as AgenCConfig,
    });
    for (const key of MANAGED_ONLY_CONFIG_KEYS) {
      expect(plugin.config[key]).toBeUndefined();
      expect(plugin.sources.find((layer) => layer.scope === "plugin")?.config[key])
        .toBeUndefined();
    }
    expect(plugin.ignored.map(({ key }) => key).sort()).toEqual(
      [...MANAGED_ONLY_CONFIG_KEYS].sort(),
    );

    const managedRoot = temporaryRoot();
    const managedPath = join(managedRoot, "managed.toml");
    writeConfig(managedPath, MANAGED_VALUES);
    const managed = await loadLayeredConfig({
      ...repositoryOptions(managedRoot),
      managedConfigPath: managedPath,
    });
    for (const [key, value] of Object.entries(MANAGED_VALUES)) {
      expect(managed.config[key as keyof AgenCConfig]).toEqual(value);
      expect(managed.provenance[key]?.scope).toBe("managed");
    }
  });

  test("rejects managed-only user TOML with migration guidance", async () => {
    const root = temporaryRoot();
    writeConfig(join(root, "home", "config.toml"), {
      availableModels: ["grok-4.6"],
    });
    await expect(loadLayeredConfig(repositoryOptions(root))).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/user config.*managed-only key availableModels.*managed config\.toml/u),
    });
  });

  test("allows operator values in user TOML and strips every one from project/local", async () => {
    const root = temporaryRoot();
    writeConfig(join(root, "home", "config.toml"), OPERATOR_VALUES);
    writeConfig(join(root, "project", ".agenc", "config.toml"), {
      gateway: { defaultAgent: "project", hooks: { enabled: true } },
      modelOverrides: { "grok-4.6": "project-override" },
      allowedMcpServers: [{ serverName: "project" }],
      allowedHttpHookUrls: ["https://project.example/*"],
      httpHookAllowedEnvVars: ["PROJECT_TOKEN"],
      minimumVersion: "99.0.0",
    });
    const loaded = await loadLayeredConfig(repositoryOptions(root));
    for (const [key, value] of Object.entries(OPERATOR_VALUES)) {
      expect(loaded.config[key as keyof AgenCConfig]).toEqual(value);
      expect(loaded.sources.find((layer) => layer.scope === "project")?.config[key as keyof AgenCConfig])
        .toBeUndefined();
    }
    expect(loaded.ignored.map(({ key }) => key).sort()).toEqual(
      [...OPERATOR_ONLY_CONFIG_KEYS].sort(),
    );
    for (const [key, value] of Object.entries(OPERATOR_VALUES)) {
      expect(() => assertConfigPatchAuthority("project", { [key]: value }))
        .toThrow(`operator-only key ${key}`);
    }
  });

  test("keeps command-bearing keymaps under user/managed authority", async () => {
    const root = temporaryRoot();
    const userBindings = [{
      context: "Chat",
      bindings: { "ctrl+x": "command:todos" },
    }];
    const managedBindings = [{
      context: "Chat",
      bindings: { "ctrl+y": "command:tasks" },
    }];
    writeConfig(join(root, "home", "config.toml"), {
      tui: { keybindings: userBindings },
    });
    writeConfig(join(root, "project", ".agenc", "config.toml"), {
      tui: {
        theme: "light",
        keybindings: [{
          context: "Chat",
          bindings: { "ctrl+z": "command:exit" },
        }],
      },
    });
    const managedPath = join(root, "managed.toml");
    writeConfig(managedPath, { tui: { keybindings: managedBindings } });

    const loaded = await loadLayeredConfig({
      ...repositoryOptions(root),
      managedConfigPath: managedPath,
      pluginDefaults: {
        tui: {
          keybindings: [{
            context: "Chat",
            bindings: { "ctrl+p": "command:plugins" },
          }],
        },
      },
    });

    expect(loaded.config.tui?.theme).toBe("light");
    expect(loaded.config.tui?.keybindings).toEqual(managedBindings);
    expect(loaded.provenance["tui.keybindings"]?.scope).toBe("managed");
    expect(loaded.ignored.filter(({ key }) => key === "tui.keybindings"))
      .toEqual([
        expect.objectContaining({ scope: "plugin" }),
        expect.objectContaining({ scope: "project" }),
      ]);
    expect(() => assertConfigPatchAuthority("project", {
      tui: { keybindings: userBindings },
    })).toThrow(/operator-only key tui\.keybindings/u);
    expect(() => assertConfigPatchAuthority("local", {
      tui: { keybindings: userBindings },
    })).toThrow(/operator-only key tui\.keybindings/u);
  });

  test("unions structural denies and never lets later layers undo monotonic restrictions", () => {
    const layers: ConfigLayerSnapshot[] = [
      {
        scope: "user",
        label: "user",
        config: {
          deniedMcpServers: [{ serverName: "one" }],
          disableAllHooks: true,
        },
      },
      {
        scope: "project",
        label: "project",
        config: {
          deniedMcpServers: [
            { serverName: "one" },
            { serverUrl: "https://blocked.example/*" },
          ],
          disableAllHooks: false,
          disableAutoMode: "disable",
        },
      },
      {
        scope: "managed",
        label: "managed",
        config: { disableAllHooks: false },
      },
    ];
    expect(mergeConfigLayerSnapshots(layers)).toMatchObject({
      deniedMcpServers: [
        { serverName: "one" },
        { serverUrl: "https://blocked.example/*" },
      ],
      disableAllHooks: true,
      disableAutoMode: "disable",
    });
  });

  test("strips untrusted repository command hooks without captured authority", async () => {
    const root = temporaryRoot();
    writeConfig(join(root, "project", ".agenc", "config.toml"), {
      hooks: {
        PreToolUse: [{
          matcher: "system.bash",
          hooks: [{ type: "command", command: "untrusted-project-hook" }],
        }],
      },
    });

    const loaded = await loadLayeredConfig({
      ...repositoryOptions(root),
      projectTrusted: false,
      retainUntrustedProjectCommandHooks: false,
    });
    const project = loaded.sources.find((layer) => layer.scope === "project")
      ?.config;

    expect(loaded.config.hooks).toBeUndefined();
    expect(project?.hooks).toBeUndefined();
    expect(loaded.ignored).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "project", key: "hooks" }),
    ]));
  });

  test("retains only captured hooks from untrusted project and local executable config", async () => {
    const root = temporaryRoot();
    const executableConfig = {
      model: "untrusted-model",
      permissions: { allow: ["system.bash(*)"] },
      tools_config: { enabled_tools: ["WebSearch"] },
      mcp_servers: {
        docs: { command: "untrusted-mcp-command", args: ["--stdio"] },
      },
      lsp_servers: {
        typescript: {
          command: "untrusted-lsp-command",
          extensionToLanguage: { ".ts": "typescript" },
        },
      },
      statusLine: { type: "command", command: "untrusted-status-command" },
      fileSuggestion: {
        type: "command",
        command: "untrusted-suggestion-command",
      },
      autoFix: { enabled: true, lint: "untrusted-lint-command" },
      browser: { executable_path: "/untrusted-browser" },
      shell_environment_policy: { set: { UNTRUSTED_MARKER: "active" } },
      attachments: { allowedRoots: ["/untrusted-root"] },
      protocol: {
        enabled: true,
        adapter: "marketplace-cli",
        cli_path: "/untrusted-cli",
      },
      daemon: { autostart: true },
    } as const;
    writeConfig(join(root, "project", ".agenc", "config.toml"), {
      ...executableConfig,
      hooks: {
        PreToolUse: [{
          matcher: "system.bash",
          hooks: [{ type: "command", command: "captured-project-hook" }],
        }],
      },
    });
    writeConfig(join(root, "project", ".agenc", "config.local.toml"), {
      ...executableConfig,
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: "captured-local-hook" }],
        }],
      },
    });

    const options = repositoryOptions(root);
    const store = new ConfigStore({
      env: options.env,
      projectRoot: options.projectRoot,
      managedConfigPath: options.managedConfigPath,
      managedDropInDir: options.managedDropInDir,
      projectTrusted: false,
      retainUntrustedProjectCommandHooks: true,
    });
    const config = await store.reload();
    const project = store.sources("project")
      .find((layer) => layer.scope === "project")?.config;
    const local = store.sources("local")
      .find((layer) => layer.scope === "local")?.config;

    expect(project?.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      "captured-project-hook",
    );
    expect(local?.hooks?.Stop?.[0]?.hooks[0]?.command).toBe(
      "captured-local-hook",
    );
    expect(config.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      "captured-project-hook",
    );
    expect(config.hooks?.Stop?.[0]?.hooks[0]?.command).toBe(
      "captured-local-hook",
    );

    for (const layer of [project, local]) {
      expect(layer?.model).toBeUndefined();
      expect(layer?.permissions?.allow).toBeUndefined();
      expect(layer?.tools_config).toBeUndefined();
      expect(layer?.mcp_servers).toBeUndefined();
      expect(layer?.lsp_servers).toBeUndefined();
      expect(layer?.statusLine).toBeUndefined();
      expect(layer?.fileSuggestion).toBeUndefined();
      expect(layer?.autoFix).toBeUndefined();
      expect(layer?.browser).toBeUndefined();
      expect(layer?.shell_environment_policy).toBeUndefined();
      expect(layer?.attachments).toBeUndefined();
      expect(layer?.protocol).toBeUndefined();
      expect(layer?.daemon).toBeUndefined();
    }
    expect(store.ignored().map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        "model",
        "permissions.allow",
        "tools_config",
        "mcp_servers",
        "lsp_servers",
        "statusLine",
        "fileSuggestion",
        "autoFix",
        "browser",
        "shell_environment_policy",
        "attachments",
        "protocol",
        "daemon",
      ]),
    );
  });

  test("trusted repository declarations survive while embedded grants are removed without values", async () => {
    const root = temporaryRoot();
    writeConfig(join(root, "project", ".agenc", "config.toml"), {
      permissions: {
        allow: ["system.bash(*)"],
        deny: ["system.bash(rm:*)"],
        ask: ["system.bash(git push:*)"],
        bypassPermissionsMode: "allow",
      },
      tools_config: {
        WebSearch: { default_permission_mode: "never" },
        enabled_tools: ["WebSearch"],
        disabled_tools: ["DangerousTool"],
        web_search_endpoint: "https://project.invalid/search",
      },
      mcp_servers: {
        docs: {
          command: "trusted-mcp-command",
          args: ["--stdio"],
          default_tools_approval_mode: "never",
          enabled_tools: ["read"],
          disabled_tools: ["write"],
          virtual_no_fs_write_tools: ["browser_navigate"],
          tools: {
            read: { default_permission_mode: "never" },
          },
        },
      },
      hooks: {
        PreToolUse: [{
          matcher: "system.bash",
          hooks: [{ type: "command", command: "trusted-hook-command" }],
        }],
      },
      lsp_servers: {
        typescript: {
          command: "trusted-lsp-command",
          extensionToLanguage: { ".ts": "typescript" },
        },
      },
      attachments: { allowedRoots: ["/sensitive-root"] },
      providers: {
        grok: {
          base_url: "https://project.invalid/provider",
          remote_mcp: {
            enabled: true,
            servers: [{
              server_url: "https://project.invalid/mcp",
              server_label: "project",
            }],
          },
        },
      },
      auth: { backend: "remote" },
      profiles: { project: { approval_policy: "never" } },
      browser: {
        executable_path: "/sensitive-browser",
        profile_dir: "/sensitive-profile",
        allow_private_network: true,
        no_sandbox: true,
        headless: true,
      },
      protocol: { enabled: true, adapter: "marketplace-cli", cli_path: "/sensitive-cli" },
      daemon: { autostart: true },
      xaa_idp: { issuer: "https://project.invalid/idp", client_id: "sensitive-client" },
      autonomous_mode: true,
      coordinator_mode: true,
      disableAllHooks: false,
      autoMode: { allow: ["system.bash"] },
      shell_environment_policy: {
        set: { PROJECT_MARKER: "repository-value" },
      },
      statusLine: { type: "command", command: "sensitive-status-command" },
      fileSuggestion: { type: "command", command: "sensitive-suggestion-command" },
      autoFix: { enabled: true, lint: "sensitive-lint-command" },
      buffer: {
        neovim: { executable: "/sensitive-nvim" },
        prediction: { enabled: "on", provider: "grok", model: "grok-4.6" },
      },
    });

    const loaded = await loadLayeredConfig(repositoryOptions(root));
    const project = loaded.sources.find((layer) => layer.scope === "project")?.config;
    expect(project?.permissions).toMatchObject({
      deny: ["system.bash(rm:*)"],
      ask: ["system.bash(git push:*)"],
    });
    expect(project?.permissions?.allow).toBeUndefined();
    expect(project?.permissions?.bypassPermissionsMode).toBeUndefined();
    expect(project?.tools_config?.disabled_tools).toEqual(["DangerousTool"]);
    expect(project?.tools_config?.WebSearch?.default_permission_mode).toBeUndefined();
    expect(project?.mcp_servers?.docs?.command).toBe("trusted-mcp-command");
    expect(project?.mcp_servers?.docs?.disabled_tools).toEqual(["write"]);
    expect(project?.mcp_servers?.docs?.default_tools_approval_mode).toBeUndefined();
    expect(project?.mcp_servers?.docs?.virtual_no_fs_write_tools).toBeUndefined();
    expect(project?.hooks?.PreToolUse).toHaveLength(1);
    expect(project?.lsp_servers?.typescript?.command).toBe("trusted-lsp-command");
    expect(project?.providers).toBeUndefined();
    expect(project?.auth).toBeUndefined();
    expect(project?.profiles).toBeUndefined();
    expect(project?.attachments).toBeUndefined();
    expect(project?.protocol).toBeUndefined();
    expect(project?.daemon).toBeUndefined();
    expect(project?.xaa_idp).toBeUndefined();
    expect(project?.autonomous_mode).toBeUndefined();
    expect(project?.coordinator_mode).toBeUndefined();
    expect(project?.disableAllHooks).toBeUndefined();
    expect(project?.autoMode).toBeUndefined();
    expect(project?.browser).toEqual({ headless: true });
    expect(project?.shell_environment_policy?.set).toBeUndefined();
    expect(project?.statusLine).toBeUndefined();
    expect(project?.fileSuggestion).toBeUndefined();
    expect(project?.autoFix).toBeUndefined();
    expect(project?.buffer?.neovim?.executable).toBeUndefined();
    expect(project?.buffer?.prediction).toBeUndefined();

    const ignored = loaded.ignored.map(({ key }) => key);
    expect(ignored).toEqual(expect.arrayContaining([
      "permissions.allow",
      "permissions.bypassPermissionsMode",
      "tools_config.WebSearch.default_permission_mode",
      "tools_config.enabled_tools",
      "mcp_servers.docs.default_tools_approval_mode",
      "mcp_servers.docs.virtual_no_fs_write_tools",
      "mcp_servers.docs.tools.read.default_permission_mode",
      "attachments",
      "providers",
      "auth",
      "profiles",
      "browser.executable_path",
      "browser.allow_private_network",
      "protocol",
      "daemon",
      "xaa_idp",
      "autonomous_mode",
      "disableAllHooks",
      "autoMode",
      "shell_environment_policy.set",
      "statusLine",
      "fileSuggestion",
      "autoFix",
      "buffer.neovim.executable",
      "buffer.prediction",
    ]));
    expect(JSON.stringify(loaded.ignored)).not.toContain("secret-value");
    expect(JSON.stringify(project)).not.toContain("sensitive-");
  });
});
