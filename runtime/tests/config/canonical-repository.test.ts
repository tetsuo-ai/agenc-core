import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  RetiredConfigDirError,
  resolveHomeContext,
  resolveMigrationHomeContext,
} from "./home.js";
import { classifyRetiredField } from "./retired-field-manifest.js";
import {
  applyConfigV2Migration,
  checkConfigV2Migration,
  ConfigMigrationError,
  rollbackConfigV2Migration,
} from "./migration.js";
import {
  ConfigRepositoryError,
  loadCanonicalDaemonConfig,
  loadLayeredConfig,
  readStrictConfigLayer,
  resolveMcpLayerCandidates,
  type ConfigLayerSnapshot,
} from "./repository.js";
import { parseCanonicalStateDocument } from "./state.js";
import { ConfigStore } from "./store.js";

const temporaryDirectories: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function persistedBypassConsent(canonicalCwd: string) {
  const identity = lstatSync(canonicalCwd, { bigint: true });
  return {
    version: 1,
    canonicalCwd,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
  };
}

function mcpLayer(
  scope: ConfigLayerSnapshot["scope"],
  mcpServers: NonNullable<ConfigLayerSnapshot["config"]["mcp_servers"]>,
): ConfigLayerSnapshot {
  return {
    scope,
    label: `${scope} layer`,
    config: { mcp_servers: mcpServers },
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("HomeContext", () => {
  test("uses AGENC_HOME as the sole normal authority", () => {
    const platformHome = temp("agenc-platform-home");
    const configured = join(platformHome, "custom");
    expect(resolveHomeContext({ AGENC_HOME: configured }, { platformHome }).path)
      .toBe(configured);
    expect(() => resolveHomeContext({
      AGENC_HOME: configured,
      AGENC_CONFIG_DIR: configured,
    }, { platformHome })).toThrow(RetiredConfigDirError);
  });

  test.each(["", "   "])(
    "rejects a defined retired config dir even when its value is %j",
    (retiredConfigDir) => {
      const platformHome = temp("agenc-empty-retired-config-dir");

      expect(() => resolveHomeContext({
        AGENC_CONFIG_DIR: retiredConfigDir,
      }, { platformHome })).toThrow(RetiredConfigDirError);
    },
  );

  test("gives implicit and explicit default homes the same identity", () => {
    const platformHome = temp("agenc-default-home");
    const defaultPath = join(platformHome, ".agenc");

    expect(resolveHomeContext({}, { platformHome })).toMatchObject({
      path: defaultPath,
      isDefault: true,
    });
    expect(resolveHomeContext(
      { AGENC_HOME: defaultPath },
      { platformHome },
    )).toMatchObject({ path: defaultPath, isDefault: true });
  });

  test("rejects relative homes instead of binding identity to process cwd", () => {
    const platformHome = temp("agenc-relative-platform-home");

    expect(() => resolveHomeContext(
      { AGENC_HOME: "relative-home" },
      { platformHome },
    )).toThrow(/must be an absolute path/u);
  });

  test("allows legacy config dir only for migration and rejects split roots", () => {
    const platformHome = temp("agenc-migration-home");
    const legacy = join(platformHome, "legacy");
    expect(resolveMigrationHomeContext({ AGENC_CONFIG_DIR: legacy }, { platformHome }).path)
      .toBe(legacy);
    expect(() => resolveMigrationHomeContext({
      AGENC_HOME: join(platformHome, "one"),
      AGENC_CONFIG_DIR: join(platformHome, "two"),
    }, { platformHome })).toThrow(/refuses to guess/u);
  });
});

describe("strict layered repository", () => {
  test("keeps daemon configuration independent from the launch workspace", async () => {
    const root = temp("agenc-daemon-home-authority");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const cwd = join(projectRoot, "nested");
    mkdirSync(cwd, { recursive: true });
    write(join(projectRoot, ".git"), "");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'model = "grok-4.5"',
      "",
    ].join("\n"));
    write(join(projectRoot, ".agenc", "config.toml"), [
      "config_version = 2",
      'model_provider = "openai"',
      'model = "gpt-5"',
      "",
    ].join("\n"));
    write(join(projectRoot, ".agenc", "config.local.toml"), [
      "config_version = 2",
      'model = "gpt-5-mini"',
      "",
    ].join("\n"));
    write(join(projectRoot, ".agenc", "settings.json"), "{}\n");
    write(join(projectRoot, ".mcp.json"), "{}\n");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      const loaded = await loadCanonicalDaemonConfig({
        env: { AGENC_HOME: home, HOME: root },
        managedConfigPath: join(root, "missing-managed.toml"),
        managedDropInDir: join(root, "missing-managed.d"),
      });

      expect(loaded.projectRoot).toBe(home);
      expect(loaded.config).toMatchObject({
        model_provider: "grok",
        model: "grok-4.5",
      });
      expect(loaded.sources.map((source) => source.scope)).not.toEqual(
        expect.arrayContaining(["project", "local", "flag", "cli"]),
      );
      await expect(loadLayeredConfig({
        env: { AGENC_HOME: home, HOME: root },
        cwd,
        managedConfigPath: join(root, "missing-managed.toml"),
        managedDropInDir: join(root, "missing-managed.d"),
      })).rejects.toMatchObject({
        code: "retired-input",
        path: join(projectRoot, ".agenc", "settings.json"),
      } satisfies Partial<ConfigRepositoryError>);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test("keeps global retired-input rejection in the daemon loader", async () => {
    const root = temp("agenc-daemon-retired-global-authority");
    const home = join(root, "home");
    write(join(home, "settings.json"), "{}\n");

    await expect(loadCanonicalDaemonConfig({
      env: { AGENC_HOME: home, HOME: root },
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-managed.d"),
    })).rejects.toMatchObject({
      code: "retired-input",
      path: join(home, "settings.json"),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("uses explicit-config root markers before loading project config and applying a profile", async () => {
    const root = temp("agenc-explicit-root-markers");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const cwd = join(projectRoot, "packages", "worker");
    const flagPath = join(root, "operator.toml");
    const projectPath = join(projectRoot, ".agenc", "config.toml");
    mkdirSync(cwd, { recursive: true });
    write(join(projectRoot, ".operator-root"), "");
    write(projectPath, [
      "config_version = 2",
      'model = "grok-4.3"',
      "",
    ].join("\n"));
    write(flagPath, [
      "config_version = 2",
      'project_root_markers = [".operator-root"]',
      "[profiles.operator]",
      'model = "grok-4.5"',
      "",
    ].join("\n"));

    const loaded = await loadLayeredConfig({
      env: { AGENC_HOME: home, HOME: root },
      cwd,
      flagConfigPath: flagPath,
      profileName: "operator",
      projectTrusted: true,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-drop-ins"),
    });

    expect(loaded.projectRoot).toBe(projectRoot);
    expect(loaded.config).toMatchObject({
      project_root_markers: [".operator-root"],
      model: "grok-4.5",
    });
    expect(loaded.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "project", path: projectPath }),
      expect.objectContaining({ scope: "flag", path: flagPath }),
      expect.objectContaining({ scope: "profile", label: "profile operator" }),
    ]));
  });

  test("rejects a late synthetic CLI root-marker authority", async () => {
    const root = temp("agenc-late-cli-root-markers");
    const cwd = join(root, "project", "nested");
    mkdirSync(cwd, { recursive: true });

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: join(root, "home"), HOME: root },
      cwd,
      cliOverrides: { project_root_markers: [".late-root"] },
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-drop-ins"),
    })).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/command-line.*project_root_markers.*root discovery/iu),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("rejects one path serving as both user and project configuration", async () => {
    const root = temp("agenc-config-scope-path-collision");
    const projectRoot = join(root, "project");
    const home = join(projectRoot, ".agenc");
    write(
      join(home, "config.toml"),
      'config_version = 2\nmodel = "grok-4.6"\n',
    );

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: home },
      projectRoot,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-drop-ins"),
    })).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/user.*project.*same physical file/iu),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("rejects hard-linked files serving as user and flag configuration", async () => {
    const root = temp("agenc-config-scope-inode-collision");
    const home = join(root, "home");
    const userPath = join(home, "config.toml");
    const flagPath = join(root, "explicit.toml");
    write(userPath, 'config_version = 2\nmodel = "grok-4.6"\n');
    linkSync(userPath, flagPath);

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: home },
      projectRoot: join(root, "project"),
      flagConfigPath: flagPath,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-drop-ins"),
    })).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/user.*flag.*same physical file/iu),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("requires schema v2 and rejects unknown top-level keys", async () => {
    const root = temp("agenc-strict-config");
    const path = join(root, "config.toml");
    write(path, "model = \"grok-4.6\"\n");
    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "invalid-version",
    } satisfies Partial<ConfigRepositoryError>);
    write(path, "config_version = 2\nunknown_operator_key = true\n");
    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "unknown-key",
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("fails closed when a managed drop-in is a symbolic link", async () => {
    const root = temp("agenc-managed-drop-in-symlink");
    const target = join(root, "policy-target.toml");
    const dropInDir = join(root, "config.d");
    write(target, "config_version = 2\ndisableAllHooks = true\n");
    mkdirSync(dropInDir, { recursive: true });
    symlinkSync(target, join(dropInDir, "10-policy.toml"));

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: join(root, "home") },
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: dropInDir,
    })).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/managed configuration may not be a symbolic link/u),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("fails closed when a managed drop-in is not a regular file", async () => {
    const root = temp("agenc-managed-drop-in-directory");
    const dropInDir = join(root, "config.d");
    mkdirSync(join(dropInDir, "10-policy.toml"), { recursive: true });

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: join(root, "home") },
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: dropInDir,
    })).rejects.toMatchObject({
      code: "invalid-source",
      message: expect.stringMatching(/not a regular file/u),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("rejects obsolete duplicate keys inside schema-v2 profiles", async () => {
    const root = temp("agenc-strict-profile-config");
    const path = join(root, "config.toml");
    write(path, [
      "config_version = 2",
      "[profiles.dev]",
      "web_search = true",
      "[profiles.dev.tools]",
      "view_image = true",
      "",
    ].join("\n"));
    await expect(readStrictConfigLayer(path, "user")).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/profiles\.dev\.(?:web_search|tools).*unknown field/u),
    } satisfies Partial<ConfigRepositoryError>);
  });

  test("attributes an inferred model to the provider-only layer that selected it", async () => {
    const root = temp("agenc-provider-only-layer");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'model_provider = "openai"',
      "",
    ].join("\n"));

    const resolved = await loadLayeredConfig({
      env: { AGENC_HOME: home },
      projectRoot: root,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-managed.d"),
    });

    expect(resolved.config).toMatchObject({
      model_provider: "openai",
      model: "gpt-5",
    });
    expect(resolved.provenance.model_provider?.scope).toBe("user");
    expect(resolved.provenance.model?.scope).toBe("user");
    expect(resolved.sources.find((layer) => layer.scope === "user")?.config)
      .toMatchObject({ model_provider: "openai", model: "gpt-5" });
  });

  test("keeps the provider/model pair atomic across every authority layer", async () => {
    const root = temp("agenc-provider-model-layers");
    const home = join(root, "home");
    const managed = join(root, "managed.toml");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'model_provider = "openai"',
      "",
    ].join("\n"));
    write(managed, [
      "config_version = 2",
      'model = "gpt-5"',
      "",
    ].join("\n"));

    const resolved = await loadLayeredConfig({
      env: {
        AGENC_HOME: home,
        AGENC_MODEL: "claude-opus-4-7",
      },
      projectRoot: root,
      managedConfigPath: managed,
      managedDropInDir: join(root, "missing-managed.d"),
      cliOverrides: { model_provider: "grok" },
    });

    expect(resolved.sources.find((layer) => layer.scope === "user")?.config)
      .toMatchObject({ model_provider: "openai", model: "gpt-5" });
    expect(
      resolved.sources.find((layer) => layer.scope === "environment")?.config,
    ).toMatchObject({
      model_provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(resolved.sources.find((layer) => layer.scope === "cli")?.config)
      .toMatchObject({ model_provider: "grok", model: "grok-4.6" });
    expect(resolved.sources.find((layer) => layer.scope === "managed")?.config)
      .toMatchObject({ model_provider: "openai", model: "gpt-5" });
    expect(resolved.config).toMatchObject({
      model_provider: "openai",
      model: "gpt-5",
    });
    expect(resolved.provenance.model_provider?.scope).toBe("managed");
    expect(resolved.provenance.model?.scope).toBe("managed");
  });

  test.each([
    { selection: { AGENC_PROVIDER: "grok" }, selector: "provider" },
    { selection: { AGENC_MODEL: "grok-4.6" }, selector: "model" },
  ])(
    "preserves explicit environment $selector intent when the selected pair is unchanged",
    async ({ selection }) => {
      const root = temp("agenc-equal-environment-selection");
      const home = join(root, "home");
      const resolved = await loadLayeredConfig({
        env: { AGENC_HOME: home, ...selection },
        projectRoot: root,
        managedConfigPath: join(root, "missing-managed.toml"),
        managedDropInDir: join(root, "missing-managed.d"),
      });

      expect(
        resolved.sources.find((layer) => layer.scope === "environment")?.config,
      ).toMatchObject({ model_provider: "grok", model: "grok-4.6" });
      expect(resolved.provenance.model_provider?.scope).toBe("environment");
      expect(resolved.provenance.model?.scope).toBe("environment");
    },
  );

  test("preserves an explicit profile pair when it equals the inherited pair", async () => {
    const root = temp("agenc-equal-profile-selection");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[profiles.same]",
      'model_provider = "grok"',
      "",
    ].join("\n"));

    const resolved = await loadLayeredConfig({
      env: { AGENC_HOME: home },
      profileName: "same",
      projectRoot: root,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-managed.d"),
    });

    expect(resolved.sources.find((layer) => layer.scope === "profile")?.config)
      .toMatchObject({ model_provider: "grok", model: "grok-4.6" });
    expect(resolved.provenance.model_provider?.scope).toBe("profile");
    expect(resolved.provenance.model?.scope).toBe("profile");
  });

  test("rejects an ambiguous model at the layer that introduces it", async () => {
    const root = temp("agenc-ambiguous-model-layer");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'model = "shared-model"',
      "[providers.grok]",
      'default_model = "shared-model"',
      "[providers.openai]",
      'default_model = "shared-model"',
      "",
    ].join("\n"));

    await expect(loadLayeredConfig({
      env: { AGENC_HOME: home },
      projectRoot: root,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-managed.d"),
    })).rejects.toThrow(/ambiguous/u);
  });

  test("tracks provenance and prevents untrusted repository grants", async () => {
    const root = temp("agenc-layered-config");
    const home = join(root, "home");
    const project = join(root, "project");
    const managed = join(root, "managed.toml");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "model = \"user-model\"",
      "[permissions]",
      "allow = [\"system.bash(user:*)\"]",
      "",
    ].join("\n"));
    write(join(project, ".agenc", "config.toml"), [
      "config_version = 2",
      "model = \"project-model\"",
      "sandbox_mode = \"danger-full-access\"",
      "[permissions]",
      "allow = [\"system.bash(project:*)\"]",
      "deny = [\"system.bash(rm:*)\"]",
      "[hooks]",
      'PreToolUse = [{ matcher = "system.bash", hooks = [{ type = "command", command = "check-project-hook" }] }]',
      "[sandbox]",
      "allow_gpu = true",
      "network_access = true",
      "allowUnsandboxedCommands = true",
      "autoAllowBashIfSandboxed = true",
      "enableWeakerNestedSandbox = true",
      "enableWeakerNetworkIsolation = true",
      "excludedCommands = [\"dangerous-helper\"]",
      "[sandbox.filesystem]",
      "allowWrite = [\"/\"]",
      "[sandbox.network]",
      "allowedDomains = [\"*\"]",
      "[sandbox.ripgrep]",
      'command = "project-rg"',
      'args = ["--unsafe"]',
      "[tools_config]",
      'enabled_tools = ["WebSearch"]',
      "[browser]",
      "allow_private_network = true",
      "no_sandbox = true",
      "",
    ].join("\n"));
    write(managed, "config_version = 2\nmodel = \"managed-model\"\n");

    const resolved = await loadLayeredConfig({
      env: { AGENC_HOME: home, AGENC_MODEL: "env-model" },
      projectRoot: project,
      managedConfigPath: managed,
      managedDropInDir: join(root, "missing-drop-ins"),
      projectTrusted: false,
    });
    expect(resolved.config.model).toBe("managed-model");
    expect(resolved.config.permissions?.allow).toEqual(["system.bash(user:*)"]);
    expect(resolved.config.permissions?.deny).toEqual(["system.bash(rm:*)"]);
    expect(resolved.config.sandbox_mode).toBe("workspace-write");
    expect(resolved.config.hooks).toBeUndefined();
    expect(resolved.config.tools_config).toBeUndefined();
    expect(resolved.config.browser).toBeUndefined();
    expect(resolved.config.sandbox?.allow_gpu).toBeUndefined();
    expect(resolved.config.sandbox?.allowUnsandboxedCommands).toBeUndefined();
    expect(resolved.config.sandbox?.network).toBeUndefined();
    expect(resolved.config.sandbox?.network_access).toBeUndefined();
    expect(resolved.config.sandbox?.filesystem).toBeUndefined();
    expect(resolved.config.sandbox?.ripgrep).toBeUndefined();
    const projectedProject = resolved.sources.find(
      (layer) => layer.scope === "project",
    )?.config;
    expect(projectedProject?.model).toBeUndefined();
    expect(projectedProject?.hooks).toBeUndefined();
    expect(projectedProject?.tools_config).toBeUndefined();
    expect(projectedProject?.browser).toBeUndefined();
    expect(projectedProject?.permissions?.allow).toBeUndefined();
    expect(projectedProject?.permissions?.deny).toEqual(["system.bash(rm:*)"]);
    expect(projectedProject?.sandbox?.allow_gpu).toBeUndefined();
    expect(projectedProject?.sandbox?.network_access).toBeUndefined();
    expect(projectedProject?.sandbox?.ripgrep).toBeUndefined();
    expect(resolved.provenance.model?.scope).toBe("managed");
    expect(resolved.ignored.map((item) => item.key)).toEqual(
      expect.arrayContaining([
        "permissions.allow",
        "model",
        "hooks",
        "tools_config",
        "browser",
        "sandbox_mode",
        "sandbox.allow_gpu",
        "sandbox.allowUnsandboxedCommands",
        "sandbox.autoAllowBashIfSandboxed",
        "sandbox.enableWeakerNestedSandbox",
        "sandbox.enableWeakerNetworkIsolation",
        "sandbox.excludedCommands",
        "sandbox.filesystem",
        "sandbox.network",
        "sandbox.network_access",
        "sandbox.ripgrep",
      ]),
    );
  });

  test("trusted repository config cannot choose a sandbox executable", async () => {
    const root = temp("agenc-trusted-repository-sandbox-command");
    const home = join(root, "home");
    const project = join(root, "project");
    write(join(project, ".agenc", "config.toml"), [
      "config_version = 2",
      "[sandbox.ripgrep]",
      'command = "project-rg"',
      'args = ["--unsafe"]',
      "",
    ].join("\n"));

    const resolved = await loadLayeredConfig({
      env: { AGENC_HOME: home },
      projectRoot: project,
      projectTrusted: true,
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-drop-ins"),
    });

    expect(resolved.config.sandbox?.ripgrep).toBeUndefined();
    expect(
      resolved.sources.find((layer) => layer.scope === "project")?.config
        .sandbox?.ripgrep,
    ).toBeUndefined();
    expect(resolved.ignored).toEqual([
      expect.objectContaining({
        scope: "project",
        key: "sandbox.ripgrep",
      }),
    ]);
  });
});

describe("MCP layer candidate resolution", () => {
  test("preserves the full non-managed repository precedence order", () => {
    const orderedScopes = [
      "default",
      "plugin",
      "user",
      "project",
      "local",
      "flag",
      "profile",
      "environment",
      "cli",
    ] as const;
    const offeredScopes: string[] = [];
    const layers = orderedScopes.map((scope) => mcpLayer(scope, {
      shared: { command: `${scope}-command` },
    }));

    const resolved = resolveMcpLayerCandidates(layers, (candidate) => {
      offeredScopes.push(candidate.source.scope);
      return "accept";
    });

    expect(resolved.managedExclusive).toBe(false);
    expect(offeredScopes).toEqual(orderedScopes);
    expect(
      resolved.candidatesByName.get("shared")?.map(
        (candidate) => candidate.source.scope,
      ),
    ).toEqual(orderedScopes);
    expect(resolved.winners.get("shared")).toMatchObject({
      source: { scope: "cli" },
      config: { command: "cli-command" },
    });
    expect(
      resolved.winners.get("shared")?.contributors.map(
        (source) => source.scope,
      ),
    ).toEqual(orderedScopes);
  });

  test("deep-merges same-name declarations while repository denials accumulate", () => {
    const resolved = resolveMcpLayerCandidates([
      mcpLayer("user", {
        shared: {
          command: "node",
          args: ["user.mjs"],
          env: { BASE: "1", SHARED: "user" },
          enabled_tools: ["read", "write"],
          disabled_tools: ["user-deny"],
          tools: {
            read: { default_permission_mode: "on-request" },
          },
        },
      }),
      mcpLayer("project", {
        shared: {
          args: ["project.mjs"],
          env: { PROJECT: "1", SHARED: "project" },
          disabled_tools: ["project-deny"],
        },
      }),
      mcpLayer("local", {
        shared: {
          env: { LOCAL: "1" },
          disabled_tools: ["local-deny", "user-deny"],
        },
      }),
    ]);

    expect(resolved.winners.get("shared")?.config).toEqual({
      command: "node",
      args: ["project.mjs"],
      env: {
        BASE: "1",
        SHARED: "project",
        PROJECT: "1",
        LOCAL: "1",
      },
      enabled_tools: ["read", "write"],
      disabled_tools: ["user-deny", "project-deny", "local-deny"],
      tools: {
        read: { default_permission_mode: "on-request" },
      },
    });
    expect(
      resolved.winners.get("shared")?.contributors.map(
        (source) => source.scope,
      ),
    ).toEqual(["user", "project", "local"]);
  });

  test("does not let a rejected declaration contaminate a later candidate", () => {
    const offered = new Map<string, ConfigLayerSnapshot["config"]>();
    const resolved = resolveMcpLayerCandidates([
      mcpLayer("user", {
        shared: {
          command: "allowed-base",
          args: ["base.mjs"],
          env: { BASE: "yes" },
          disabled_tools: ["base-deny"],
        },
      }),
      mcpLayer("project", {
        shared: {
          command: "blocked-project",
          args: ["blocked.mjs"],
          env: { LEAK: "no" },
          disabled_tools: ["blocked-deny"],
        },
      }),
      mcpLayer("local", {
        shared: {
          command: "allowed-local",
          env: { LOCAL: "yes" },
          disabled_tools: ["local-deny"],
        },
      }),
    ], (candidate) => {
      offered.set(candidate.source.scope, {
        mcp_servers: { [candidate.name]: candidate.config },
      });
      return candidate.source.scope === "project" ? "reject" : "accept";
    });

    expect(offered.get("local")?.mcp_servers?.shared).toEqual({
      command: "allowed-local",
      args: ["base.mjs"],
      env: { BASE: "yes", LOCAL: "yes" },
      disabled_tools: ["base-deny", "local-deny"],
    });
    expect(resolved.winners.get("shared")?.config).toEqual(
      offered.get("local")?.mcp_servers?.shared,
    );
    expect(
      resolved.candidatesByName.get("shared")?.map(
        (candidate) => candidate.source.scope,
      ),
    ).toEqual(["user", "local"]);
    expect(
      resolved.winners.get("shared")?.contributors.map(
        (source) => source.scope,
      ),
    ).toEqual(["user", "local"]);
  });

  test("defers an incomplete trusted substrate until a later layer completes it", () => {
    const resolved = resolveMcpLayerCandidates([
      mcpLayer("user", {
        shared: {
          args: ["substrate.mjs"],
          env: { BASE: "1" },
        },
      }),
      mcpLayer("flag", {
        shared: { command: "node" },
      }),
    ], (candidate) => (
      candidate.config.command === undefined &&
      candidate.config.endpoint === undefined
        ? "defer"
        : "accept"
    ));

    expect(resolved.unresolved.has("shared")).toBe(false);
    expect(resolved.candidatesByName.get("shared")).toHaveLength(1);
    expect(resolved.winners.get("shared")).toMatchObject({
      source: { scope: "flag" },
      declaration: { command: "node" },
      config: {
        command: "node",
        args: ["substrate.mjs"],
        env: { BASE: "1" },
      },
    });
    expect(
      resolved.winners.get("shared")?.contributors.map(
        (source) => source.scope,
      ),
    ).toEqual(["user", "flag"]);
  });

  test("retains an incomplete-only declaration as unresolved", () => {
    const resolved = resolveMcpLayerCandidates([
      mcpLayer("user", {
        shared: {
          args: ["orphan.mjs"],
          env: { BASE: "1" },
        },
      }),
    ], () => "defer");

    expect(resolved.candidatesByName.has("shared")).toBe(false);
    expect(resolved.winners.has("shared")).toBe(false);
    expect(resolved.unresolved.get("shared")).toMatchObject({
      source: { scope: "user" },
      contributors: [{ scope: "user" }],
      config: {
        args: ["orphan.mjs"],
        env: { BASE: "1" },
      },
    });
  });

  test("treats an explicitly empty managed table as exclusive", () => {
    const offeredScopes: string[] = [];
    const resolved = resolveMcpLayerCandidates([
      mcpLayer("user", {
        shared: { command: "user-command" },
      }),
      mcpLayer("managed", {}),
    ], (candidate) => {
      offeredScopes.push(candidate.source.scope);
      return "accept";
    });

    expect(resolved.managedExclusive).toBe(true);
    expect(offeredScopes).toEqual([]);
    expect(resolved.candidatesByName.size).toBe(0);
    expect(resolved.unresolved.size).toBe(0);
    expect(resolved.winners.size).toBe(0);
  });
});

describe("explicit v2 migration", () => {
  test("rejects duplicate keys in canonical state before parsing", async () => {
    const root = temp("agenc-migration-duplicate-state");
    const home = join(root, "home");
    write(
      join(home, "state.json"),
      '{"state_version":1,"state":{"global":{},"global":{}}}\n',
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "duplicate-canonical-state",
      scope: "all",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: join(home, "state.json"),
        reason: expect.stringMatching(/duplicate object key/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("repairs retired canonical settings while preserving stable exact-cwd consent", async () => {
    const root = temp("agenc-migration-state-namespace-upgrade");
    const home = join(root, "home");
    const acceptedCwd = join(root, "accepted-workspace");
    mkdirSync(acceptedCwd, { recursive: true });
    const canonicalAcceptedCwd = realpathSync(acceptedCwd);
    const statePath = join(home, "state.json");
    const retiredState = `${JSON.stringify({
      state_version: 1,
      state: {
        global: {
          installMethod: "native",
          settings: {
            fastModePerSessionOptIn: true,
            bypassPermissionsModeAcceptedIn: [acceptedCwd],
          },
        },
      },
    })}\n`;
    write(statePath, retiredState, 0o666);

    expect(() => parseCanonicalStateDocument(retiredState, statePath)).toThrow(
      /agenc config migrate/u,
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "canonical-state-namespace-upgrade",
      scope: "all",
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: statePath,
        field: "state.global.settings.fastModePerSessionOptIn",
        action: "drop",
      }),
      expect.objectContaining({
        sourcePath: statePath,
        field: "state.global.settings.bypassPermissionsModeAcceptedIn",
        action: "migrate",
        target: "state.global.permissions.bypassPermissionsAcceptedByCwd",
      }),
    ]));
    const stateWrite = plan.writes.find((write) => write.kind === "state");
    expect(stateWrite).toBeDefined();
    expect(stateWrite?.mode).toBe(0o600);
    expect(parseCanonicalStateDocument(stateWrite!.content, statePath).state)
      .toEqual({
        global: {
          installMethod: "native",
          permissions: {
            bypassPermissionsAcceptedByCwd: {
              [canonicalAcceptedCwd]: persistedBypassConsent(
                canonicalAcceptedCwd,
              ),
            },
          },
        },
      });

    await applyConfigV2Migration(plan);
    expect(parseCanonicalStateDocument(readFileSync(statePath, "utf8"), statePath).state)
      .toEqual({
        global: {
          installMethod: "native",
          permissions: {
            bypassPermissionsAcceptedByCwd: {
              [canonicalAcceptedCwd]: persistedBypassConsent(
                canonicalAcceptedCwd,
              ),
            },
          },
        },
      });
    if (process.platform !== "win32") {
      expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    }
  });

  test("preserves config-file mode while planning a canonical rewrite", async () => {
    if (process.platform === "win32") return;
    const root = temp("agenc-migration-config-mode");
    const home = join(root, "home");
    const configPath = join(home, "config.toml");
    write(configPath, "configVersion = 1\n", 0o640);

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "canonical-config-mode",
      scope: "all",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    expect(configWrite?.targetPath).toBe(configPath);
    expect(configWrite?.mode).toBe(0o640);
  });

  test("blocks relative and nonexistent cwd grants during canonical state repair", async () => {
    const root = temp("agenc-migration-invalid-bypass-cwd");
    const home = join(root, "home");
    const statePath = join(home, "state.json");
    write(statePath, JSON.stringify({
      state_version: 1,
      state: {
        global: {
          settings: {
            bypassPermissionsModeAcceptedIn: [
              "relative/workspace",
              join(root, "missing-workspace"),
            ],
          },
        },
      },
    }));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "invalid-canonical-bypass-cwd",
      scope: "all",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: statePath,
        field: "state.global.settings.bypassPermissionsModeAcceptedIn[0]",
        reason: expect.stringMatching(/absolute and normalized/u),
      }),
      expect.objectContaining({
        sourcePath: statePath,
        field: "state.global.settings.bypassPermissionsModeAcceptedIn[1]",
        reason: expect.stringMatching(/stable existing directory/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
    expect(readFileSync(statePath, "utf8")).toContain(
      "bypassPermissionsModeAcceptedIn",
    );
  });

  test("migrates retired user settings consent but never accepts workspace authority", async () => {
    const root = temp("agenc-migration-settings-bypass-consent");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const acceptedCwd = join(root, "accepted-workspace");
    mkdirSync(acceptedCwd, { recursive: true });
    const canonicalAcceptedCwd = realpathSync(acceptedCwd);
    write(join(home, "settings.json"), JSON.stringify({
      bypassPermissionsModeAcceptedIn: [acceptedCwd],
    }));

    const userPlan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "user-settings-bypass-consent",
      scope: "user",
    });

    expect(userPlan.conflicts).toEqual([]);
    const stateWrite = userPlan.writes.find((write) => write.kind === "state");
    expect(parseCanonicalStateDocument(stateWrite!.content).state).toEqual({
      global: {
        permissions: {
          bypassPermissionsAcceptedByCwd: {
            [canonicalAcceptedCwd]: persistedBypassConsent(
              canonicalAcceptedCwd,
            ),
          },
        },
      },
    });

    write(join(projectRoot, ".agenc", "settings.json"), JSON.stringify({
      bypassPermissionsModeAcceptedIn: [acceptedCwd],
    }));
    const workspacePlan = await checkConfigV2Migration({
      env: {},
      home: join(root, "other-home"),
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "workspace-settings-bypass-consent",
      scope: "all",
    });
    expect(workspacePlan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "project",
        field: "bypassPermissionsModeAcceptedIn",
        reason: expect.stringMatching(/cannot be granted/u),
      }),
    ]));
    expect(workspacePlan.writes).toEqual([]);
  });

  test("refuses one file as both user and project migration target", async () => {
    const root = temp("agenc-migration-scope-path-collision");
    const projectRoot = join(root, "project");
    const home = join(projectRoot, ".agenc");
    write(
      join(home, "config.toml"),
      'configVersion = 1\nmodel = "grok-4.6"\n',
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "scope-path-collision",
      scope: "all",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: expect.stringMatching(/user.*project.*same physical file/iu),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("refuses hard-linked retired inputs from different scopes", async () => {
    const root = temp("agenc-migration-source-inode-collision");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const userSettings = join(home, "settings.json");
    const projectSettings = join(projectRoot, ".agenc", "settings.json");
    write(userSettings, '{"theme":"dark"}\n');
    mkdirSync(join(projectRoot, ".agenc"), { recursive: true });
    linkSync(userSettings, projectSettings);

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "source-inode-collision",
      scope: "all",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: expect.stringMatching(/retired input.*same physical file.*inode/iu),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("maps the retired editor toggle into tui.vimMode", async () => {
    const root = temp("agenc-v2-editor-mode");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      'configVersion = 1\neditorMode = "vim"\n',
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "editor-mode",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find(write => write.kind === "config");
    expect(configWrite?.content).toMatch(/"?vimMode"?\s*=\s*true/u);
    expect(configWrite?.content).not.toContain("editorMode");
  });

  test("refuses conflicting editorMode and tui.vimMode values", async () => {
    const root = temp("agenc-v2-editor-conflict");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        'editorMode = "vim"',
        "[tui]",
        "vimMode = false",
        "",
      ].join("\n"),
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "editor-conflict",
    });

    expect(plan.conflicts).toEqual([
      expect.objectContaining({ field: "tui.vimMode" }),
    ]);
  });

  test("consolidates legacy effort and sandbox policy into canonical fields", async () => {
    const root = temp("agenc-v2-effort-sandbox");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        'effortLevel = "max"',
        "[sandbox_policy]",
        'mode = "workspace-write"',
        "network_access = true",
        'writable_roots = ["./cache"]',
        "",
      ].join("\n"),
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "effort-sandbox",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find(write => write.kind === "config");
    expect(configWrite?.content).toContain('"reasoning_effort" = "xhigh"');
    expect(configWrite?.content).toContain('"sandbox_mode" = "workspace-write"');
    expect(configWrite?.content).toContain('"network_access" = true');
    expect(configWrite?.content).toContain('"allowWrite" = ["./cache"]');
    expect(configWrite?.content).not.toContain('"writable_roots"');
    expect(configWrite?.content).not.toContain("effortLevel");
    expect(configWrite?.content).not.toContain("sandbox_policy");
  });

  test("migrates duplicate v1 profile tool selectors to canonical list authority", async () => {
    const root = temp("agenc-v2-profile-tools");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        "[profiles.dev]",
        "web_search = false",
        "[profiles.dev.tools]",
        "view_image = true",
        "",
      ].join("\n"),
    );
    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "profile-tools",
    });
    expect(plan.conflicts).toEqual([]);
    const content = plan.writes.find(write => write.kind === "config")?.content;
    expect(content).toContain('["profiles"."dev"."tools_config"]');
    expect(content).toContain('"disabled_tools" = ["WebSearch"]');
    expect(content).not.toContain('"web_search"');
    expect(content).not.toContain('"view_image"');
    expect(content).not.toContain('["profiles"."dev"."tools"]');
  });

  test("refuses conflicting canonical and legacy effort values", async () => {
    const root = temp("agenc-v2-effort-conflict");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        'reasoning_effort = "low"',
        'effortLevel = "max"',
        "",
      ].join("\n"),
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "effort-conflict",
    });
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ field: "reasoning_effort" }),
    ]);
  });

  test("moves legacy global environment injection into shell_environment_policy", async () => {
    const root = temp("agenc-v2-global-env");
    const home = join(root, "home");
    const globalStatePath = join(root, "global.json");
    write(globalStatePath, JSON.stringify({
      env: { AGENC_TEST_VALUE: "legacy" },
    }));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      globalStatePath,
      id: "global-env",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find(write => write.kind === "config");
    expect(configWrite?.content).toContain('"shell_environment_policy"');
    expect(configWrite?.content).toContain('"AGENC_TEST_VALUE" = "legacy"');
  });

  test("retains only runtime project facts from legacy global state", async () => {
    const root = temp("agenc-v2-project-runtime-state");
    const home = join(root, "home");
    const globalStatePath = join(root, "global.json");
    write(globalStatePath, JSON.stringify({
      projects: {
        "/repo": {
          lastAPIDuration: 42,
          lastSessionId: "session-1",
          projectOnboardingSeenCount: 1,
          activeWorktreeSession: {
            originalCwd: "/repo",
            worktreePath: "/tmp/repo-worktree",
            worktreeName: "feature",
            sessionId: "session-1",
          },
        },
      },
    }));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath,
      id: "project-runtime-state",
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "projects./repo.projectOnboardingSeenCount",
        action: "drop",
      }),
    ]));
    const stateWrite = plan.writes.find(write => write.kind === "state");
    const migratedState = JSON.parse(stateWrite?.content ?? "null");
    expect(migratedState).toMatchObject({
      state_version: 1,
      state: {
        global: {
          projects: {
            "/repo": {
              lastAPIDuration: 42,
              lastSessionId: "session-1",
            },
          },
        },
      },
    });
    expect(
      migratedState.state.global.projects["/repo"],
    ).not.toHaveProperty("projectOnboardingSeenCount");
  });

  test("blocks project trust and executable policy from legacy global state", async () => {
    const root = temp("agenc-v2-project-authority-state");
    const home = join(root, "home");
    const globalStatePath = join(root, "global.json");
    write(globalStatePath, JSON.stringify({
      projects: {
        "/repo": {
          lastAPIDuration: 42,
          hasTrustDialogAccepted: true,
          allowedTools: ["Bash"],
        },
      },
    }));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath,
      id: "project-authority-state",
    });

    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        scope: "state",
        reason: expect.stringMatching(/project trust decisions.*trusted-projects\.json/u),
      }),
    ]);
    expect(plan.writes.some(write => write.kind === "state")).toBe(false);
  });

  test("refuses conflicting canonical and legacy global environment values", async () => {
    const root = temp("agenc-v2-global-env-conflict");
    const home = join(root, "home");
    const globalStatePath = join(root, "global.json");
    write(
      join(home, "config.toml"),
      [
        "config_version = 2",
        "[shell_environment_policy.set]",
        'AGENC_TEST_VALUE = "canonical"',
        "",
      ].join("\n"),
    );
    write(globalStatePath, JSON.stringify({ env: { AGENC_TEST_VALUE: "legacy" } }));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      globalStatePath,
      id: "global-env-conflict",
    });

    expect(plan.conflicts).toEqual([
      expect.objectContaining({ field: "shell_environment_policy.set.AGENC_TEST_VALUE" }),
    ]);
  });

  test("checks, applies, archives legacy JSON, and rolls back", async () => {
    const root = temp("agenc-v2-migration");
    const home = join(root, "home");
    const project = join(root, "project");
    const managed = join(root, "managed", "config.toml");
    const original = "configVersion = 1\nmodel = \"legacy-model\"\n";
    write(join(home, "config.toml"), original);
    write(join(home, "settings.json"), "{\"spinnerTipsEnabled\":false}\n");

    const options = {
      env: {},
      home,
      projectRoot: project,
      managedConfigPath: managed,
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "test-migration",
    } as const;
    const plan = await checkConfigV2Migration(options);
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.map((item) => item.kind)).toEqual(["config"]);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(original);

    const applied = await applyConfigV2Migration(plan);
    expect(applied.id).toBe("test-migration");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      '"config_version" = 2',
    );
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(
      '"spinnerTipsEnabled" = false',
    );
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(existsSync(`${join(home, "settings.json")}.migrated-v2-test-migration`)).toBe(true);
    expect(existsSync(join(home, "state.json"))).toBe(false);

    const rolledBack = await rollbackConfigV2Migration("test-migration", { home, env: {} });
    expect(rolledBack.restored).toBeGreaterThan(0);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(home, "settings.json"))).toBe(true);
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });

  test("blocks credentials and unknown passthrough fields without writes", async () => {
    const root = temp("agenc-v2-conflict");
    const home = join(root, "home");
    write(join(home, "settings.json"), JSON.stringify({
      agentModels: { custom: { base_url: "https://example.test", api_key: "secret" } },
      futurePassthrough: true,
    }));
    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "blocked",
    });
    expect(plan.conflicts.map((item) => item.field)).toEqual(
      expect.arrayContaining(["agentModels", "futurePassthrough"]),
    );
    await expect(applyConfigV2Migration(plan)).rejects.toBeInstanceOf(ConfigMigrationError);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  test("migration is the only path that accepts removed per-tool permission aliases", async () => {
    const root = temp("agenc-v2-per-tool-alias");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[tools_config.Edit]",
      'defaultPermissionMode = "never"',
      "[tools_config.Write]",
      'approval_mode = "prompt"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "per-tool-alias",
    });
    expect(plan.conflicts).toEqual([]);
    const content = plan.writes.find((item) => item.kind === "config")?.content;
    expect(content).toContain('"default_permission_mode" = "never"');
    expect(content).toContain('"default_permission_mode" = "untrusted"');
    expect(content).not.toContain("defaultPermissionMode");
    expect(content).not.toContain("approval_mode");
  });
});

describe("runtime v2 cutover", () => {
  test("ConfigStore uses strict layered config and never falls back on errors", async () => {
    const root = temp("agenc-v2-runtime-store");
    const home = join(root, "home");
    const project = join(root, "project");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'model = "canonical-at-startup"',
      "",
    ].join("\n"));

    const store = new ConfigStore({
      home,
      cwd: project,
      projectRoot: project,
      projectTrusted: false,
      managedConfigPath: join(root, "managed", "config.toml"),
      managedDropInDir: join(root, "managed", "config.d"),
      env: { HOME: root },
    });
    await expect(store.reload()).resolves.toMatchObject({
      configVersion: 2,
      model: "canonical-at-startup",
    });

    write(join(home, "config.toml"), [
      "config_version = 2",
      "unknown_runtime_authority = true",
      "",
    ].join("\n"));
    await expect(store.reload()).rejects.toMatchObject({
      code: "unknown-key",
      path: join(home, "config.toml"),
      message: expect.stringContaining("unknown schema-v2 key"),
    } satisfies Partial<ConfigRepositoryError>);
    expect(store.current().model).toBe("canonical-at-startup");
  });
});

describe("retired-field migration manifest", () => {
  test("classifies reviewed and passthrough fields exhaustively", () => {
    expect(classifyRetiredField("settings-json", "agentModels").authority).toBe("credential");
    expect(classifyRetiredField("global-state", "numStartups")).toMatchObject({
      authority: "removed",
      action: "drop",
    });
    expect(classifyRetiredField("settings-json", "effortLevel")).toMatchObject({
      action: "transform",
      target: "reasoning_effort",
    });
    expect(classifyRetiredField(
      "settings-json",
      "fastModePerSessionOptIn",
    )).toMatchObject({ authority: "removed", action: "drop" });
    expect(classifyRetiredField(
      "settings-json",
      "bypassPermissionsModeAcceptedIn",
    )).toMatchObject({
      authority: "state",
      action: "transform",
      target: "state.global.permissions.bypassPermissionsAcceptedByCwd",
    });
    expect(classifyRetiredField("config-toml-v1", "sandbox_policy")).toMatchObject({
      action: "transform",
      target: "sandbox_mode,sandbox",
    });
    expect(classifyRetiredField("global-state", "providerProfiles")).toMatchObject({
      authority: "credential",
      action: "block",
    });
    expect(classifyRetiredField("global-state", "cachedChangelog")).toMatchObject({
      authority: "removed",
      action: "drop",
    });
    expect(
      classifyRetiredField("global-state", "penguinModeOrgEnabled"),
    ).toMatchObject({
      authority: "removed",
      action: "drop",
    });
    expect(
      classifyRetiredField("global-state", "agencAiMcpEverConnected"),
    ).toMatchObject({
      authority: "removed",
      action: "drop",
    });
    expect(classifyRetiredField("settings-json", "future-key")).toMatchObject({
      authority: "unclassified",
      action: "block",
    });
  });
});
