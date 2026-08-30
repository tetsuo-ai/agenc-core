import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "runtime/src");
const RUNTIME_TEST_ROOT = resolve(REPOSITORY_ROOT, "runtime/tests");
const GENERATED_DIRECTORY_NAMES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

function filesBelow(path: string, suffix: RegExp): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return suffix.test(path) ? [path] : [];
  return readdirSync(path)
    .filter((entry) => !GENERATED_DIRECTORY_NAMES.has(entry))
    .flatMap((entry) => filesBelow(resolve(path, entry), suffix));
}

const documentationFiles = [
  resolve(REPOSITORY_ROOT, "README.md"),
  ...filesBelow(resolve(REPOSITORY_ROOT, "docs"), /\.md$/u),
  ...filesBelow(resolve(REPOSITORY_ROOT, "runtime"), /README\.md$/u),
  ...filesBelow(resolve(REPOSITORY_ROOT, "packages"), /\.md$/u),
  ...filesBelow(resolve(REPOSITORY_ROOT, "packaging"), /\.md$/u),
];

const operatorReferenceBoundary = new Set([
  "docs/reference/config.md",
  "docs/reference/env.md",
  "docs/reference/providers.md",
]);

const retainedSecureStorageTerminologyFiles = new Set([
  "bin/config-cli-v2-migration.test.ts",
  "config/plaintext-credential-migration.test.ts",
  "config/retired-auth-migration.test.ts",
  "utils/secureStorage/migrationIdentity.test.ts",
]);

const retainedSecureStorageTerminologyPatterns = new Map<string, RegExp>([
  ["bin/security-cli.test.ts", /\bvault files\b|wallet\.vault\.json/iu],
  [
    "config/config-authority-residue.architecture.test.ts",
    /\\bvault files\\b|wallet\\\.vault\\\.json|PasswordVault|PASSWORDVAULT|AGENC_WALLET_VAULT_PASSPHRASE|vault passphrase\|vault-passphrase|readCacheByVault\|refreshStateByVault\|vaultIdentity\|vaultValues|\/vault\/iu\.test\(line\)/u,
  ],
  [
    "config/home-state-authority.architecture.test.ts",
    /PasswordVault|PASSWORDVAULT/u,
  ],
  ["fixtures/hermetic-env-contract.json", /AGENC_WALLET_VAULT_PASSPHRASE/u],
  ["helpers/hermetic-env.mjs", /AGENC_WALLET_VAULT_PASSPHRASE/u],
  ["hermetic-test-discovery.test.ts", /AGENC_WALLET_VAULT_PASSPHRASE/u],
  [
    "secrets/sanitizer-wallet-c1.test.ts",
    /vault passphrase|vault-passphrase|AGENC_WALLET_VAULT_PASSPHRASE/iu,
  ],
  ["utils/secureStorage/platformStorage.test.ts", /PasswordVault/u],
]);

// Split the spellings so this guard does not match its own source.
const retiredProviderSelector = new RegExp(
  "\\b(?:AGENC_" +
    "USE_(?:GEMINI|OPENAI|MISTRAL|GITHUB|MINIMAX|BEDROCK|VERTEX|FOUNDRY)|NVIDIA_" +
    "NIM)\\b",
  "u",
);

const retiredManagedInstructionRoot = new RegExp(
  "(?:/etc/agenc-" +
    "code|/Library/Application Support/AgenC" +
    "Code|C:\\\\Program Files\\\\AgenC" +
    "Code)",
  "u",
);

const retiredDocumentationTerms = new Map<string, RegExp>([
  [
    "retired operator JSON path",
    /(?:~\/\.agenc\.json|\.agenc\/(?:\.config|config|settings(?:\.local)?)\.json)/iu,
  ],
  ["retired managed JSON path", /managed-settings(?:\.json|\.d)?/iu],
  ["retired managed instruction root", retiredManagedInstructionRoot],
  ["retired --settings flag", /(?:^|\s)--settings(?:\s|$|[=`])/mu],
  ["retired apiKeyHelper config", /\bapiKeyHelper\b/u],
  ["retired home alias", /\bAGENC_CONFIG_DIR\b/u],
  [
    "retired provider-profile state",
    /\b(?:providerProfiles|activeProviderProfileId)\b/u,
  ],
  ["retired effort key", /\beffortLevel\b/u],
  ["retired plugin key", /\benabledPlugins\b/u],
  ["retired permission key", /\bpermissions\.default_mode\b/u],
  ["retired auto-mode key", /\bautoMode\.deny\b/u],
  ["retired sandbox toggle", /\bsandbox\.enabled\b/u],
  [
    "invalid system theme value",
    /(?:\btheme\s*=|["']theme["']\s*:)\s*["']system["']/iu,
  ],
  [
    "retired MCP ws config spelling",
    /(?:\btransport\s*=|["']transport["']\s*:)\s*["']ws["']/iu,
  ],
  [
    "parallel config-loader claim",
    /\b(?:multiple|two) config(?:uration)? (?:loaders?|surfaces)\b/iu,
  ],
  [
    "parallel settings JSON hook surface",
    /settings-style config|TOML vs settings JSON/iu,
  ],
  [
    "deleted documentation link",
    /(?:daemon-architecture-assessment-2026-08-20|daemon-autostart-spin-2026-08-23|releases\/(?:0\.11\.0|0\.11\.1|0\.6\.2|0\.7\.0|0\.7\.1)\.md)/u,
  ],
]);

describe("configuration authority residue", () => {
  test("bundled-skill extraction has one session-temp authority adapter", () => {
    const adapter =
      /getBundledSkillExtractionRoot\(\s*resolveSessionTempRoot\(\)\s*\)/u;
    const owners = filesBelow(SOURCE_ROOT, /\.(?:ts|tsx)$/u)
      .filter((path) => adapter.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path));

    expect(owners).toEqual(["skills/bundled-root-authority.ts"]);
  });

  test("retired provider selector names cannot re-enter code, tests, or documentation", () => {
    const executableSurface =
      /\.(?:cjs|js|json|mjs|ps1|sh|toml|ts|tsx|yaml|yml)$/u;
    const files = [
      ...filesBelow(
        resolve(REPOSITORY_ROOT, "runtime"),
        executableSurface,
      ),
      ...filesBelow(resolve(REPOSITORY_ROOT, "runtime/bin"), /./u),
      ...filesBelow(resolve(REPOSITORY_ROOT, "packages"), executableSurface),
      ...filesBelow(resolve(REPOSITORY_ROOT, "packaging"), executableSurface),
      ...filesBelow(resolve(REPOSITORY_ROOT, "scripts"), executableSurface),
      ...filesBelow(resolve(REPOSITORY_ROOT, ".github"), executableSurface),
      ...filesBelow(resolve(REPOSITORY_ROOT, ".githooks"), /./u),
      ...filesBelow(resolve(REPOSITORY_ROOT, "parity"), executableSurface),
      resolve(REPOSITORY_ROOT, "package-lock.json"),
      resolve(REPOSITORY_ROOT, "package.json"),
      resolve(REPOSITORY_ROOT, "release-toolchain.json"),
      ...documentationFiles,
    ];
    const violations = files
      .filter((path) =>
        retiredProviderSelector.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(REPOSITORY_ROOT, path));

    expect(violations).toEqual([]);
  });

  test("protocol runtime has no null-adapter implementation", () => {
    const protocolRoot = resolve(SOURCE_ROOT, "protocol");
    const source = filesBelow(protocolRoot, /\.ts$/u)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(existsSync(resolve(protocolRoot, "null-transport.ts"))).toBe(false);
    expect(source).not.toMatch(/\bNullTransport\b|TRANSPORT_NOT_CONFIGURED/u);
    expect(source).not.toMatch(/adapter[^\n]{0,40}["'`]null["'`]/u);
  });

  test("fixed runtime features cannot reopen a hidden config surface", () => {
    const features = readFileSync(
      resolve(SOURCE_ROOT, "llm/registry/features.ts"),
      "utf8",
    );
    expect(features).not.toMatch(/config\.features|_unknown\.features/u);
    expect(features).not.toMatch(/LEGACY_FEATURE_ALIASES|AgenCFeatureSet/u);

    const source = filesBelow(SOURCE_ROOT, /\.(?:ts|tsx)$/u)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/useLegacyLandlock|use_legacy_landlock/u);
    expect(source).not.toMatch(
      /hook-chains\.json|AGENC_(?:ENABLE_HOOK_CHAINS|HOOK_CHAINS_CONFIG_PATH)/u,
    );
  });

  test("TUI settings have one exact schema and one theme-value registry", () => {
    const strictSchema = readFileSync(
      resolve(SOURCE_ROOT, "config/strict-schema.ts"),
      "utf8",
    );
    const schema = readFileSync(resolve(SOURCE_ROOT, "config/schema.ts"), "utf8");
    const theme = readFileSync(resolve(SOURCE_ROOT, "utils/theme.ts"), "utf8");

    expect(strictSchema).toContain('tui: delegatedObjectValidator("tui")');
    expect(strictSchema).not.toMatch(/function validateTui\b/u);
    expect(schema).toContain("export function validateTuiConfig");
    expect(schema).toContain("export const TUI_THEME_SETTINGS");
    expect(theme).toContain("TUI_THEME_SETTINGS");
    expect(theme).not.toContain("export const THEME_SETTINGS");
  });

  test("native secure-storage code does not restore retired terminology", () => {
    const source = [
      "utils/openAiOauthCredentials.ts",
      "utils/githubModelsCredentials.ts",
      "utils/xaiOauthCredentials.ts",
      "utils/plugins/pluginConfigAuthority.ts",
    ]
      .map((path) => readFileSync(resolve(SOURCE_ROOT, path), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /\b(?:readCacheByVault|refreshStateByVault|vaultIdentity|vaultValues)\b/u,
    );
  });

  test("retired secure-storage terminology remains inside explicit contracts", () => {
    const violations = filesBelow(
      RUNTIME_TEST_ROOT,
      /\.(?:cjs|js|json|mjs|ts|tsx)$/u,
    ).flatMap((path) => {
      const name = relative(RUNTIME_TEST_ROOT, path);
      if (retainedSecureStorageTerminologyFiles.has(name)) return [];
      const retainedPattern = retainedSecureStorageTerminologyPatterns.get(name);
      return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => {
          if (!/vault/iu.test(line) || retainedPattern?.test(line)) return [];
          return [`${name}:${index + 1}`];
        });
    });

    expect(violations).toEqual([]);
  });

  test("documentation outside the migration reference does not advertise retired authority", () => {
    const violations = documentationFiles.flatMap((path) => {
      const name = relative(REPOSITORY_ROOT, path);
      if (operatorReferenceBoundary.has(name)) return [];
      const content = readFileSync(path, "utf8");
      return [...retiredDocumentationTerms].flatMap(([label, pattern]) =>
        pattern.test(content) ? [`${name}: ${label}`] : [],
      );
    });

    expect(violations).toEqual([]);
  });

  test("mcpServers remains documented only in the migration reference and plugin metadata", () => {
    const allowedDocumentation = new Set([
      "docs/reference/config.md",
      "docs/reference/mcp.md",
      "docs/reference/skills-plugins.md",
    ]);
    const hits = documentationFiles
      .filter((path) => /\bmcpServers\b/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPOSITORY_ROOT, path));

    const uniqueHits = [...new Set(hits)].sort();

    expect(
      uniqueHits.filter((path) => !allowedDocumentation.has(path)),
    ).toEqual([]);
    expect(uniqueHits).toEqual(
      expect.arrayContaining([
        "docs/reference/config.md",
        "docs/reference/skills-plugins.md",
      ]),
    );
  });

  test("production source cannot restore retired canonical-config spellings", () => {
    const forbidden = new Map<string, RegExp>([
      ["permissions.default_mode", /\bpermissions\.default_mode\b/u],
      ["autoMode.deny", /\bautoMode\.deny\b/u],
      [
        "theme=system",
        /(?:\btheme\s*=|["']theme["']\s*:)\s*["']system["']/iu,
      ],
      [
        "MCP transport=ws",
        /(?:\btransport\s*=|["']transport["']\s*:)\s*["']ws["']/iu,
      ],
      [
        "parallel config-loader claim",
        /\b(?:multiple|two) config(?:uration)? (?:loaders?|surfaces)\b/iu,
      ],
      ["retired managed instruction root", retiredManagedInstructionRoot],
    ]);
    const explicitMigrationBoundary = new Set([
      "config/migration.ts",
      "config/retired-field-manifest.ts",
    ]);
    const violations = filesBelow(SOURCE_ROOT, /\.(?:ts|tsx)$/u).flatMap(
      (path) => {
        const name = relative(SOURCE_ROOT, path);
        if (explicitMigrationBoundary.has(name)) return [];
        const content = readFileSync(path, "utf8");
        return [...forbidden].flatMap(([label, pattern]) =>
          pattern.test(content) ? [`${name}: ${label}`] : [],
        );
      },
    );

    expect(violations).toEqual([]);
  });

  test("retired preference env names exist only in fail-fast and secret-scrub boundaries", () => {
    const retiredPreferenceEnv = new RegExp(
      "\\bAGENC_(?:SPECULATION_" +
        "ENABLED|DISABLE_(?:GIT_INSTRUCTIONS|AUTO_MEMORY|FILE_CHECKPOINTING)|" +
        "ENABLE_SDK_FILE_CHECKPOINTING|USE_(?:READABLE_STDIN|POWERSHELL_TOOL))\\b",
      "u",
    );
    const retiredHooksAlias = new RegExp(
      "\\bAGENC_GATEWAY_" + "HOOKS_TOKEN\\b",
      "u",
    );
    const violations = filesBelow(SOURCE_ROOT, /\.(?:ts|tsx)$/u).flatMap(
      (path) => {
        const name = relative(SOURCE_ROOT, path);
        const content = readFileSync(path, "utf8");
        if (retiredPreferenceEnv.test(content) && name !== "config/env.ts") {
          return [`${name}: retired preference env`];
        }
        if (
          retiredHooksAlias.test(content) &&
          !new Set([
            "config/env.ts",
            "config/retired-auth-migration.ts",
            "gateway/run.ts",
            "utils/secretEnv.ts",
          ]).has(name)
        ) {
          return [`${name}: retired hooks-token alias`];
        }
        return [];
      },
    );

    expect(violations).toEqual([]);
  });

  test("gateway policy and secrets have no parallel file authority", () => {
    const retiredGatewayFiles =
      /gateway\/(?:config\.json|env|hooks-token|webchat-token)/u;
    const allowed = new Set([
      "bin/security-cli.ts", // Protects retired plaintext migration inputs.
      "config/migration.ts",
      "config/retired-auth-migration.ts",
    ]);
    const violations = filesBelow(SOURCE_ROOT, /\.(?:ts|tsx)$/u).flatMap(
      (path) => {
        const name = relative(SOURCE_ROOT, path);
        if (allowed.has(name)) return [];
        return retiredGatewayFiles.test(readFileSync(path, "utf8"))
          ? [name]
          : [];
      },
    );

    expect(violations).toEqual([]);
    expect(existsSync(resolve(SOURCE_ROOT, "gateway/env-file.ts"))).toBe(false);
    const adapter = readFileSync(
      resolve(SOURCE_ROOT, "gateway/config.ts"),
      "utf8",
    );
    expect(adapter).not.toMatch(/node:fs|JSON\.parse|JSON\.stringify/u);
    expect(adapter).toContain("gatewayConfigFromCanonical");
  });
});
