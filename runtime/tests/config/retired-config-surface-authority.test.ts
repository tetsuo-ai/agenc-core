import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import { checkConfigV2Migration } from "../../src/config/migration.js";
import { readStrictConfigLayer } from "../../src/config/repository.js";

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

describe("retired config surface authority", () => {
  test("retired JSON duplicate keys fail closed instead of taking the last value", async () => {
    const root = temporaryRoot("agenc-retired-json-duplicate");
    const home = join(root, "home");
    write(
      join(home, "config.json"),
      '{"model":"grok-first","model":"grok-second"}\n',
    );

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-json-duplicate",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "<duplicate-json-key>",
        reason: expect.stringMatching(/duplicate object key/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("retired JSON prototype keys fail closed without mutating Object.prototype", async () => {
    const root = temporaryRoot("agenc-retired-json-prototype");
    const home = join(root, "home");
    write(
      join(home, "config.json"),
      '{"__proto__":{"agencMigrationPolluted":true},"model":"grok-4.6"}\n',
    );

    expect(
      (Object.prototype as Record<string, unknown>).agencMigrationPolluted,
    ).toBeUndefined();
    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-json-prototype",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "__proto__",
        reason: expect.stringMatching(/object prototype/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
    expect(
      (Object.prototype as Record<string, unknown>).agencMigrationPolluted,
    ).toBeUndefined();
  });

  test.each([
    ["sandbox.failIfUnavailable", "[sandbox]\nfailIfUnavailable = true"],
    ["sandbox.writable_roots", '[sandbox]\nwritable_roots = ["./cache"]'],
    ["shell_environment_policy.inherit", '[shell_environment_policy]\ninherit = "none"'],
    [
      "shell_environment_policy.ignore_default_excludes",
      "[shell_environment_policy]\nignore_default_excludes = false",
    ],
    ["shell_environment_policy.exclude", '[shell_environment_policy]\nexclude = ["TOKEN"]'],
    ["shell_environment_policy.include_only", '[shell_environment_policy]\ninclude_only = ["PATH"]'],
    ["providers.grok.fallback_models", '[providers.grok]\nfallback_models = ["grok-3"]'],
    [
      "providers.grok.fallback.models",
      '[providers.grok.fallback]\nmodels = ["grok-3"]',
    ],
    ["plugins.plugins.demo.source", '[plugins.plugins.demo]\nsource = "legacy"'],
    ["plugins.plugins.demo.version", '[plugins.plugins.demo]\nversion = "1.0.0"'],
    ["plugins.plugins.demo.required", "[plugins.plugins.demo]\nrequired = true"],
    ["plugins.plugins.demo.options", '[plugins.plugins.demo.options]\ncolor = "blue"'],
    ["plugins.plugins.demo", "[plugins.plugins]\ndemo = true"],
    [
      "extraKnownMarketplaces",
      '[extraKnownMarketplaces.legacy.source]\nsource = "github"\nrepo = "org/plugins"',
    ],
    ["review_model", 'review_model = "grok-review"'],
    ["compact_prompt", 'compact_prompt = "compact this"'],
    ["workspace", 'workspace = "/tmp/workspace"'],
    ["advisorModel", 'advisorModel = "reviewer"'],
    ["approvals_reviewer", 'approvals_reviewer = "guardian_subagent"'],
    ["service_tier", 'service_tier = "fast"'],
    ["reasoning_effort", 'reasoning_effort = "minimal"'],
    [
      "profiles.audit.approvals_reviewer",
      '[profiles.audit]\napprovals_reviewer = "guardian_subagent"',
    ],
    ["profiles.audit.service_tier", '[profiles.audit]\nservice_tier = "fast"'],
    [
      "profiles.audit.reasoning_effort",
      '[profiles.audit]\nreasoning_effort = "minimal"',
    ],
  ])("strict schema v2 rejects %s", async (field, body) => {
    const root = temporaryRoot("agenc-retired-v2");
    const path = join(root, "config.toml");
    write(path, `config_version = 2\n${body}\n`);

    await expect(readStrictConfigLayer(path, "user")).rejects.toThrow(field);
  });

  test("explicit migration translates or drops retired fields without preserving a second authority", async () => {
    const root = temporaryRoot("agenc-retired-migration");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[providers.grok]",
      'fallback_models = ["grok-3"]',
      "[sandbox]",
      "failIfUnavailable = true",
      'writable_roots = ["./cache"]',
      "[shell_environment_policy]",
      'inherit = "none"',
      "ignore_default_excludes = false",
      'exclude = ["TOKEN"]',
      'include_only = ["PATH"]',
      "[plugins.plugins.demo]",
      "enabled = true",
      'source = "legacy"',
      'version = "1.0.0"',
      "required = true",
      "[extraKnownMarketplaces.legacy.source]",
      'source = "github"',
      'repo = "org/plugins"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-config-surface-authority",
    });

    expect(plan.conflicts).toEqual([]);
    const content = plan.writes.find((write) => write.kind === "config")?.content;
    expect(content).toBeDefined();
    const migrated = parseToml(content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({
      config_version: 2,
      providers: { grok: { fallback: { targets: [{ model: "grok-3" }] } } },
      sandbox: { filesystem: { allowWrite: ["./cache"] } },
      plugins: { plugins: { demo: { enabled: true } } },
    });
    expect(migrated).not.toHaveProperty("extraKnownMarketplaces");
    expect(migrated).not.toHaveProperty("sandbox.failIfUnavailable");
    expect(migrated).not.toHaveProperty("sandbox.writable_roots");
    expect(migrated).not.toHaveProperty("shell_environment_policy.inherit");
    expect(migrated).not.toHaveProperty("shell_environment_policy.ignore_default_excludes");
    expect(migrated).not.toHaveProperty("shell_environment_policy.exclude");
    expect(migrated).not.toHaveProperty("shell_environment_policy.include_only");
    expect(migrated).not.toHaveProperty("providers.grok.fallback_models");
    for (const field of ["source", "version", "required", "options"]) {
      expect(migrated).not.toHaveProperty(`plugins.plugins.demo.${field}`);
    }
  });

  test("explicit migration blocks plugin option blobs without a verified manifest schema", async () => {
    const root = temporaryRoot("agenc-retired-plugin-options");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[plugins.plugins.demo]",
      "enabled = true",
      'options = { color = "blue", token = "plaintext-secret" }',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-plugin-options",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "plugins.plugins.demo.options",
        reason: expect.stringMatching(/manifest schema.*reconfigure/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration blocks plaintext remote-MCP authorization", async () => {
    const root = temporaryRoot("agenc-retired-remote-mcp-secret");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "configVersion = 1",
      "[[llm.xai.remote_mcp.servers]]",
      'server_url = "https://mcp.example"',
      'server_label = "docs"',
      'authorization = "Bearer plaintext-secret"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-remote-mcp-secret",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "providers.grok.remote_mcp.servers.0.authorization",
        reason: expect.stringMatching(/authorization_env/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration folds retired llm.xai leaves into providers.grok", async () => {
    const root = temporaryRoot("agenc-retired-llm-xai");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[providers.grok]",
      'default_model = "grok-4.6"',
      "web_search = true",
      "[llm.xai]",
      "web_search = true",
      "x_search = false",
      "[llm.xai.collections]",
      "enabled = true",
      'vector_store_ids = ["docs"]',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-llm-xai",
    });

    expect(plan.conflicts).toEqual([]);
    const content = plan.writes.find((write) => write.kind === "config")?.content;
    const migrated = parseToml(content ?? "") as Record<string, unknown>;
    expect(migrated).not.toHaveProperty("llm");
    expect(migrated).toMatchObject({
      providers: {
        grok: {
          default_model: "grok-4.6",
          web_search: true,
          x_search: false,
          collections: { enabled: true, vector_store_ids: ["docs"] },
        },
      },
    });
  });

  test("explicit migration refuses conflicting llm.xai and providers.grok leaves", async () => {
    const root = temporaryRoot("agenc-retired-llm-xai-conflict");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[providers.grok]",
      "x_search = true",
      "[llm.xai]",
      "x_search = false",
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-llm-xai-conflict",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "llm.xai.x_search",
        reason: expect.stringMatching(/providers\.grok\.x_search.*refuses/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration refuses unknown llm.xai capability keys", async () => {
    const root = temporaryRoot("agenc-retired-llm-xai-unknown");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[llm.xai]",
      "web_search = true",
      'unclassified_feature = "enabled"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-llm-xai-unknown",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "llm.xai.unclassified_feature",
        reason: expect.stringMatching(/no canonical providers\.grok capability/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration rejects retired provider api_key_env indirection", async () => {
    const root = temporaryRoot("agenc-retired-provider-secret-env");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[providers.grok]",
      'api_key_env = "MY_GROK_TOKEN"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-provider-secret-env",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "providers.grok.api_key_env",
        reason: expect.stringMatching(/native secure storage/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration drops inert root fields from an existing v2 document", async () => {
    const root = temporaryRoot("agenc-retired-v2-migration");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'review_model = "grok-review"',
      'compact_prompt = "compact this"',
      'workspace = "/tmp/workspace"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-v2-root-fields",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    const migrated = parseToml(configWrite?.content ?? "") as Record<string, unknown>;
    expect(migrated).toEqual({ config_version: 2 });
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "review_model", action: "drop" }),
      expect.objectContaining({ field: "compact_prompt", action: "drop" }),
      expect.objectContaining({ field: "workspace", action: "drop" }),
    ]));
  });

  test("explicit migration deduplicates equal sandbox write-root authorities", async () => {
    const root = temporaryRoot("agenc-sandbox-write-roots-equal");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[sandbox]",
      'writable_roots = ["./cache"]',
      "[sandbox.filesystem]",
      'allowWrite = ["./cache"]',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "sandbox-write-roots-equal",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    const migrated = parseToml(configWrite?.content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({
      sandbox: { filesystem: { allowWrite: ["./cache"] } },
    });
    expect(migrated).not.toHaveProperty("sandbox.writable_roots");
  });

  test("explicit migration fails closed on unequal sandbox write-root authorities", async () => {
    const root = temporaryRoot("agenc-sandbox-write-roots-conflict");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[sandbox]",
      'writable_roots = ["./legacy"]',
      "[sandbox.filesystem]",
      'allowWrite = ["./canonical"]',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "sandbox-write-roots-conflict",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "sandbox.filesystem.allowWrite" }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration fails closed when provider fallback aliases disagree", async () => {
    const root = temporaryRoot("agenc-provider-fallback-conflict");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[providers.grok]",
      'fallback_models = ["grok-legacy"]',
      "[providers.grok.fallback]",
      'models = ["grok-nested"]',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "provider-fallback-conflict",
    });

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "providers.grok.fallback_models" }),
    ]));
    expect(plan.writes).toEqual([]);
  });

  test("explicit migration normalizes retired protocol no-op combinations", async () => {
    const root = temporaryRoot("agenc-protocol-noop");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      "[protocol]",
      "enabled = true",
      'adapter = "null"',
      'cli_path = "/unused"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "protocol-noop",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    const migrated = parseToml(configWrite?.content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({ protocol: { enabled: false } });
    expect(migrated).not.toHaveProperty("protocol.adapter");
    expect(migrated).not.toHaveProperty("protocol.cli_path");
  });

  test("explicit migration drops advisorModel and canonicalizes reviewer aliases", async () => {
    const root = temporaryRoot("agenc-retired-advisor-reviewer");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'advisorModel = "reviewer"',
      'approvals_reviewer = "guardian_subagent"',
      "[profiles.audit]",
      'approvals_reviewer = "guardian_subagent"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-advisor-reviewer",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    const migrated = parseToml(configWrite?.content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({
      approvals_reviewer: "auto_review",
      profiles: { audit: { approvals_reviewer: "auto_review" } },
    });
    expect(migrated).not.toHaveProperty("advisorModel");
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "advisorModel", action: "drop" }),
      expect.objectContaining({ field: "approvals_reviewer", action: "migrate" }),
      expect.objectContaining({
        field: "profiles.audit.approvals_reviewer",
        action: "migrate",
      }),
    ]));
  });

  test("explicit migration canonicalizes plugin booleans and retired value aliases", async () => {
    const root = temporaryRoot("agenc-retired-value-aliases");
    const home = join(root, "home");
    write(join(home, "config.toml"), [
      "config_version = 2",
      'service_tier = "fast"',
      'reasoning_effort = "minimal"',
      "[plugins.plugins]",
      "formatter = false",
      "[profiles.audit]",
      'service_tier = "fast"',
      'reasoning_effort = "minimal"',
      "",
    ].join("\n"));

    const plan = await checkConfigV2Migration({
      env: {},
      home,
      projectRoot: join(root, "project"),
      managedConfigPath: join(root, "managed", "config.toml"),
      managedSettingsPath: join(root, "managed", "managed-settings.json"),
      globalStatePath: join(root, "missing-global.json"),
      id: "retired-value-aliases",
    });

    expect(plan.conflicts).toEqual([]);
    const configWrite = plan.writes.find((write) => write.kind === "config");
    const migrated = parseToml(configWrite?.content ?? "") as Record<string, unknown>;
    expect(migrated).toMatchObject({
      service_tier: "priority",
      reasoning_effort: "low",
      plugins: { plugins: { formatter: { enabled: false } } },
      profiles: {
        audit: { service_tier: "priority", reasoning_effort: "low" },
      },
    });
    expect(plan.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "plugins.plugins.formatter",
        target: "plugins.plugins.formatter.enabled",
      }),
      expect.objectContaining({
        field: "service_tier",
        target: "service_tier=priority",
      }),
      expect.objectContaining({
        field: "reasoning_effort",
        target: "reasoning_effort=low",
      }),
    ]));
  });
});
