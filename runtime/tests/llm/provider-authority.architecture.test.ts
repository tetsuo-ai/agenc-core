import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DAEMON_CLIENT_ENV_SNAPSHOT_KEYS } from "../../src/app-server/client-env-snapshot.js";
import { CANONICAL_SESSION_ENV_KEYS } from "../../src/session/environment.js";
import { getContextWindowForModelForContext } from "../../src/utils/context.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../src/llm/registry/provider-info.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const TESTS = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../../", import.meta.url));
function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(`${path}/${entry}`));
}

describe("provider authority architecture", () => {
  test("provider metadata and ordered environment ingress have one authored table", () => {
    const registry = readFileSync(
      `${SRC}/llm/registry/provider-info.ts`,
      "utf8",
    );
    expect(registry).toMatch(/BUILT_IN_PROVIDER_DEFINITIONS/u);
    expect(registry).not.toMatch(/PROVIDER_DISPLAY_NAMES/u);
    expect(registry).not.toMatch(/BUILT_IN_PROVIDER_ONBOARDING/u);
    expect(registry).not.toMatch(/BUILT_IN_PROVIDER_API_KEY_ENVS/u);
    expect(registry).toMatch(/ProviderCredentialDefinition/u);
    expect(registry).toMatch(/credentials:\s*awsSigV4Credentials/u);

    const configSchema = readFileSync(`${SRC}/config/schema.ts`, "utf8");
    const defaultConfigSource = configSchema.match(
      /export function defaultConfig\(\): AgenCConfig \{[\s\S]*?\n\}/u,
    )?.[0] ?? "";
    expect(defaultConfigSource).toContain("DEFAULT_BUILT_IN_PROVIDER_SELECTION")
    expect(defaultConfigSource).not.toMatch(/model:\s*["']grok-4\.6["']/u)
    expect(defaultConfigSource).not.toMatch(/model_provider:\s*["']grok["']/u)

    const production = sourceFiles(SRC).filter(
      (path) => path.endsWith(".ts") || path.endsWith(".tsx"),
    );
    const keyFacadeConsumers = production
      .filter((path) =>
        /\bapiKeyEnvVars?\b/u.test(readFileSync(path, "utf8"))
      )
      .map((path) => relative(SRC, path));
    expect(keyFacadeConsumers).toEqual([]);

    const positionalPrimaryAliasConsumers = production
      .filter((path) =>
        /(?:\.envVars|apiKeyEnvVars?)\s*\[\s*0\s*\]|\bprimaryEnvVar\b/u.test(
          readFileSync(path, "utf8"),
        )
      )
      .map((path) => relative(SRC, path));
    expect(positionalPrimaryAliasConsumers).toEqual([]);

    const providerOptions = readFileSync(
      `${SRC}/llm/provider-options.ts`,
      "utf8",
    );
    expect(providerOptions).not.toMatch(/const\s+(?:API_KEY_ENV|BASE_URL_ENV)\b/u);
    expect(providerOptions).toMatch(/resolveProviderCredentialEnvironment/u);
    expect(providerOptions).not.toMatch(/resolveProviderApiKeyEnvironment/u);
    expect(providerOptions).toMatch(/resolveProviderBaseURLEnvironment/u);

    const providerCredentialConsumers = [
      "commands/provider-menu.tsx",
      "llm/discovery/provider-discovery.ts",
      "llm/provider-options.ts",
      "onboarding/Onboarding.tsx",
    ];
    const awsCredentialAlias =
      /\bAWS_(?:BEDROCK_)?(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)|\bAWS_DEFAULT_REGION\b/u;
    const reauthoredAwsAliases = providerCredentialConsumers.filter(
      (path) =>
        awsCredentialAlias.test(readFileSync(`${SRC}/${path}`, "utf8")),
    );
    expect(reauthoredAwsAliases).toEqual([]);

    const geminiProvider = readFileSync(
      `${SRC}/llm/providers/gemini/index.ts`,
      "utf8",
    );
    expect(geminiProvider).toMatch(/providerApiKeyEnvironmentLabel\("gemini"\)/u);
    expect(geminiProvider).not.toMatch(
      /GEMINI_API_KEY(?:\s*,|\s+or)\s*GOOGLE_API_KEY/u,
    );

    const configEnv = readFileSync(`${SRC}/config/env.ts`, "utf8");
    const providerBaseResolver = configEnv.match(
      /export function resolveProviderBaseURL[\s\S]*?\n\}/u,
    )?.[0];
    expect(configEnv).not.toMatch(/export function resolveProviderApiKey/u);
    expect(providerBaseResolver).toMatch(/resolveProviderBaseURLEnvironment/u);
    expect(providerBaseResolver).not.toMatch(/switch\s*\(/u);

    const providerSettings = readFileSync(
      `${SRC}/config/resolve-provider.ts`,
      "utf8",
    );
    expect(providerSettings).not.toMatch(/readonly apiKey\?/u);
    expect(providerSettings).not.toMatch(/resolveProviderApiKeyEnvironment/u);

    const discovery = readFileSync(
      `${SRC}/llm/discovery/provider-discovery.ts`,
      "utf8",
    );
    for (const path of [
      "commands/model-menu.tsx",
      "commands/provider-menu.tsx",
    ]) {
      const menu = readFileSync(`${SRC}/${path}`, "utf8");
      expect(menu, path).toMatch(/createProviderCommandAccessOverlay/u);
      expect(menu, path).not.toMatch(/resolveProviderSettings/u);
      expect(menu, path).not.toMatch(/resolveProviderCredentialEnvironment/u);
      expect(menu, path).not.toMatch(/resolveGrokProviderCredential/u);
      expect(menu, path).not.toMatch(/readXaiOauthCredentials/u);
      expect(menu, path).not.toMatch(/resolveGeminiCredentialPlan/u);
    }
    const credentialIngress = readFileSync(
      `${SRC}/llm/registry/provider-ingress.ts`,
      "utf8",
    );
    const onboarding = readFileSync(
      `${SRC}/onboarding/Onboarding.tsx`,
      "utf8",
    );
    expect(credentialIngress).toMatch(/ProviderCredentialProvenance/u);
    expect(credentialIngress).toMatch(
      /providerCredentialEnvironmentProvenance/u,
    );
    expect(credentialIngress).toMatch(/GROK_OAUTH_CREDENTIAL_PROVENANCE/u);
    expect(credentialIngress).not.toMatch(
      /providerCredentialEnvironmentReferences/u,
    );
    expect(discovery).toMatch(/type ProviderCredentialProvenance/u);
    expect(discovery).toMatch(/resolveProviderCredentialAuthority/u);
    expect(discovery).not.toMatch(/resolveProviderCredentialEnvironment/u);
    expect(discovery).not.toMatch(/resolveProviderSettings/u);
    expect(discovery).not.toMatch(/resolveProviderFactoryOptions/u);
    expect(discovery).not.toMatch(/resolveGrokProviderCredential/u);
    expect(discovery).not.toMatch(/readGeminiRuntimeOptions/u);
    expect(discovery).not.toMatch(/ProviderAvailabilityCredentialSource/u);
    expect(discovery).not.toMatch(/\bProviderKeyStatus\b|\bkeyStatus\b/u);
    expect(discovery).not.toMatch(/\bcredentialSource\b/u);
    expect(onboarding).toMatch(
      /ProviderConnectionCredentialProvenance\s*=\s*\|\s*ProviderCredentialProvenance/u,
    );
    expect(onboarding).toMatch(/\|\s*"model-access"/u);
    expect(onboarding).not.toMatch(/ProviderConnectionCredentialSource/u);
    expect(onboarding).not.toMatch(/\bneeds-key\b|\bcredentialSource\b/u);
    expect(discovery).not.toMatch(/providerApiKeyEnvCandidates/u);
    expect(discovery).not.toMatch(
      /const\s+(?:PROVIDERS_REQUIRING_KEY|MANAGED_KEY_PROVIDERS|LOCAL_PROVIDERS)\b/u,
    );
    const bootstrap = readFileSync(`${SRC}/bin/bootstrap.ts`, "utf8");
    expect(bootstrap).not.toMatch(/PROVIDER_API_KEY_ENV_HINTS/u);
    expect(bootstrap).not.toMatch(/providerApiKeyEnvHint/u);
    expect(bootstrap).not.toMatch(
      /readLocalByokFallback|vendProviderKeyOrUndefined|requireProviderApiKeyOrUndefined/u,
    );
    expect(bootstrap).toMatch(/resolveProviderRuntimeAuthority/u);

    const startupSelection = readFileSync(
      `${SRC}/bin/startup-selection.ts`,
      "utf8",
    );
    expect(startupSelection).not.toMatch(/\bapiKey\b|resolveProviderSettings/u);

    const session = readFileSync(`${SRC}/session/session.ts`, "utf8");
    const providerService = readFileSync(
      `${SRC}/session/provider-service.ts`,
      "utf8",
    );
    expect(session).not.toMatch(
      /providerFactoryOptionsFromSettings|mergeProviderFactoryOptions/u,
    );
    expect(providerService).not.toMatch(/committedFactoryOptions/u);

    const providerCommandAccess = readFileSync(
      `${SRC}/commands/provider-command-access.ts`,
      "utf8",
    );
    expect(providerCommandAccess).toMatch(/resolveProviderRuntimeRequest/u);
    expect(providerCommandAccess).not.toMatch(/committedFactoryOptions/u);
    expect(onboarding).toMatch(/resolveProviderRuntimeAuthority/u);
    expect(onboarding).not.toMatch(
      /resolveGrokProviderCredential|settings\?\.apiKey/u,
    );
    expect(
      readFileSync(`${SRC}/onboarding/useApiKeyVerification.ts`, "utf8"),
    ).toMatch(/resolveProviderCredentialAuthority/u);

    const modelMetadata = readFileSync(
      `${SRC}/llm/model-metadata.ts`,
      "utf8",
    );
    expect(modelMetadata).not.toMatch(/defaultProviderApiKeyEnv/u);
    expect(modelMetadata).toMatch(/resolveProviderApiKeyEnvironment/u);
    expect(modelMetadata).toMatch(/resolveProviderBaseURLEnvironment/u);
  });

  test("the provider registry alone authors direct Bedrock regional endpoints", () => {
    const registry = readFileSync(
      `${SRC}/llm/registry/provider-info.ts`,
      "utf8",
    );
    expect(registry).toMatch(/AMAZON_BEDROCK_REGIONAL_ENDPOINT/u);
    expect(registry).toMatch(
      /https:\/\/bedrock-runtime\.\{region\}\.amazonaws\.com/u,
    );
    expect(registry).toMatch(/defaultRegion:\s*"us-east-1"/u);

    for (const path of [
      "llm/provider.ts",
      "llm/providers/bedrock/index.ts",
      "utils/model/bedrock.ts",
    ]) {
      const source = readFileSync(`${SRC}/${path}`, "utf8");
      expect(source).toMatch(/resolveBuiltInProviderRegionalEndpoint/u);
      expect(source).not.toMatch(/bedrockBaseURLForRegion/u);
      expect(source).not.toMatch(/BEDROCK_RUNTIME_HOST_PREFIX/u);
      expect(source).not.toMatch(/bedrock-runtime\./u);
      expect(source).not.toMatch(/us-east-1/u);
    }

    const providerMenu = readFileSync(
      `${SRC}/commands/provider-menu.tsx`,
      "utf8",
    );
    expect(providerMenu).toMatch(/createProviderCommandAccessOverlay/u);
    expect(providerMenu).not.toMatch(/resolveBuiltInProviderRegionalEndpoint/u);
    expect(providerMenu).not.toMatch(/bedrock-runtime\.|us-east-1/u);

    const production = sourceFiles(SRC).filter(
      (path) => path.endsWith(".ts") || path.endsWith(".tsx"),
    );
    const retiredBedrockIngress =
      /\b(?:ANTHROPIC_BEDROCK_BASE_URL|BEDROCK_BASE_URL|AGENC_SKIP_BEDROCK_AUTH)\b/u;
    expect(
      production
        .filter((path) => retiredBedrockIngress.test(readFileSync(path, "utf8")))
        .map((path) => relative(SRC, path)),
    ).toEqual([]);
  });

  test("provider adapters derive built-in endpoints from the registry", () => {
    const providerRoot = `${SRC}/llm/providers`;
    const providerSources = sourceFiles(providerRoot)
      .filter((path) => /\.tsx?$/u.test(path))
      .map((path) => ({
        name: relative(providerRoot, path),
        source: readFileSync(path, "utf8"),
      }));

    for (const baseURL of new Set(Object.values(BUILT_IN_PROVIDER_BASE_URLS))) {
      expect(
        providerSources
          .filter(({ source }) => source.includes(baseURL))
          .map(({ name }) => name),
        `adapter sources must not re-author registry endpoint ${baseURL}`,
      ).toEqual([]);
    }

    const retiredAdapterDefaults =
      /\b(?:DEFAULT_BASE_URL|DEFAULT_DEEPSEEK_BASE_URL|DEFAULT_LMSTUDIO_BASE_URL|DEFAULT_GEMINI_BASE_URL|OPENAI_COMPATIBLE_DEFAULT_BASE_URL|OPENAI_COMPATIBLE_DEFAULT_MODEL|DEFAULT_HOST|DEFAULT_MODEL)\b/u;
    expect(
      providerSources
        .filter(({ source }) => retiredAdapterDefaults.test(source))
        .map(({ name }) => name),
    ).toEqual([]);

    const openAIAdapter = readFileSync(
      `${providerRoot}/openai/adapter.ts`,
      "utf8",
    );
    expect(openAIAdapter).toMatch(/resolveBuiltInProviderInfo\(providerName\)/u);
    expect(openAIAdapter).toMatch(/providerApiKeyEnvironmentLabel\(providerName\)/u);

    for (const path of [
      "deepseek/index.ts",
      "github/index.ts",
      "groq/index.ts",
      "lmstudio/index.ts",
      "minimax/index.ts",
      "mistral/index.ts",
      "nvidia-nim/index.ts",
      "openai-compatible/index.ts",
      "openrouter/index.ts",
    ]) {
      const source = readFileSync(`${providerRoot}/${path}`, "utf8");
      expect(source).not.toMatch(/\bapiKeyEnvLabel\s*:/u);
      expect(source).not.toMatch(/\bbaseURL\s*:/u);
    }

    const providerFactory = readFileSync(`${SRC}/llm/provider.ts`, "utf8");
    expect(providerFactory).not.toMatch(/apiKeyEnvironmentLabelFor/u);
    expect(providerFactory.match(/\bapiKeyEnvLabel\s*:/gu)).toEqual([
      "apiKeyEnvLabel:",
    ]);
    expect(providerFactory).toMatch(
      /apiKeyEnvLabel:\s*"AgenC subscription"/u,
    );
  });

  test("provider metadata does not invent transport policy or websocket support", () => {
    const clientSession = readFileSync(
      `${SRC}/llm/client-session.ts`,
      "utf8",
    );
    const grokAdapter = readFileSync(
      `${SRC}/llm/providers/grok/adapter.ts`,
      "utf8",
    );
    const registry = readFileSync(
      `${SRC}/llm/registry/provider-info.ts`,
      "utf8",
    );
    const providerMenu = readFileSync(
      `${SRC}/commands/provider-menu.tsx`,
      "utf8",
    );
    const providersDoc = readFileSync(
      `${RUNTIME}/../docs/reference/providers.md`,
      "utf8",
    );

    expect(clientSession).toMatch(
      /DEFAULT_REQUEST_MAX_RETRIES\s*=\s*4/u,
    );
    expect(clientSession).toMatch(
      /DEFAULT_STREAM_MAX_RETRIES\s*=\s*5/u,
    );
    expect(clientSession).toMatch(/DEFAULT_RETRY_BASE_DELAY_MS\s*=\s*200/u);
    expect(grokAdapter).toMatch(
      /maxRetries:\s*this\.config\.maxRetries\s*\?\?\s*2/u,
    );
    expect(existsSync(`${SRC}/llm/transport-retry-policy.ts`)).toBe(false);

    for (const source of [clientSession, registry, providerMenu]) {
      expect(source).not.toMatch(
        /supportsWebsockets|websocketConnectTimeoutMs/u,
      );
    }
    expect(registry).not.toMatch(
      /requestMaxRetries|streamMaxRetries|streamIdleTimeoutMs/u,
    );
    expect(providersDoc).not.toMatch(
      /websocket connect timeout|websockets supported/iu,
    );
    expect(providersDoc).toMatch(/Model-provider streaming uses HTTP\/SSE/u);
    expect(providersDoc).toMatch(
      /Grok uses an SDK transport with a distinct retry contract/u,
    );
  });

  test("provider selector identity has one normalizer and one retired mapping", () => {
    const production = sourceFiles(SRC).filter(
      (path) => path.endsWith(".ts") || path.endsWith(".tsx"),
    );
    const duplicateNormalizers = production.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return /(?:function|const)\s+normalizeProvider(?:Name|Slug|Key)\b/u.test(
        source,
      )
        ? [relative(SRC, path)]
        : [];
    });
    expect(duplicateNormalizers).toEqual([]);

    const retiredMapping =
      /(?:xai:\s*"grok"|custom:\s*"openai-compatible"|openai_compatible:\s*"openai-compatible")/u;
    const mappingOwners = production.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return retiredMapping.test(source) ? [relative(SRC, path)] : [];
    });
    expect(mappingOwners).toEqual(["provider-identity.ts"]);

    for (const path of [
      "config/env.ts",
      "config/resolve-provider.ts",
      "llm/registry/provider-info.ts",
      "llm/model-registry.ts",
      "llm/model-metadata.ts",
      "llm/api/fallback-ladder.ts",
      "llm/capabilities.ts",
    ]) {
      const source = readFileSync(`${SRC}/${path}`, "utf8");
      expect(source).toMatch(
        /normalizeProviderIdentity|resolveBuiltInProviderInfo|resolveBuiltInProviderSlug|resolveProviderSlug/u,
      );
    }
  });

  test("the provider factory is deterministic from its arguments", () => {
    const source = readFileSync(`${SRC}/llm/provider.ts`, "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/resolveProviderNameFromEnv/);
    expect(existsSync(`${SRC}/utils/providerValidation.ts`)).toBe(false);
  });

  test("the Grok ACP transport has no ambient environment fallback", () => {
    for (const path of [
      "llm/providers/grok/acp-adapter.ts",
      "services/xai/acp.ts",
    ]) {
      expect(readFileSync(`${SRC}/${path}`, "utf8")).not.toContain(
        "process.env",
      );
    }
  });

  test("the retired AgenC-specific xAI credential alias is rejection-only", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/u.test(path))
      .map((path) => ({
        name: relative(SRC, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ name, source }) =>
          source.includes("AGENC_XAI_API_KEY") &&
          name !== "config/env.ts" &&
          name !== "utils/secretEnv.ts",
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  test("compaction carries its provider explicitly and never stamps process env", () => {
    expect(existsSync(`${SRC}/session/compact-env-guard.ts`)).toBe(false);
    for (const relative of [
      "session/run-turn.ts",
      "session/agenc-tool-use-context.ts",
      "commands/session-compact.ts",
    ]) {
      const source = readFileSync(`${SRC}/${relative}`, "utf8");
      expect(source).not.toMatch(/withCompactContextGuards|providerOverride/);
    }
  });

  test("legacy API classification cannot select from credentials", () => {
    const source = readFileSync(`${SRC}/utils/model/providers.ts`, "utf8");
    expect(source).not.toMatch(/process\.env\.AGENC_PROVIDER/);
    expect(source).not.toMatch(/process\.env\.(?:XAI_API_KEY|MINIMAX_API_KEY)/);
    expect(source).toMatch(
      /throw new Error\([\s\S]*No provider authority is bound/u,
    );
  });

  test("provider/model selection remains session-owned after startup", () => {
    const providerSource = readFileSync(
      `${SRC}/utils/model/providers.ts`,
      "utf8",
    );
    const selectionContextSource = readFileSync(
      `${SRC}/utils/model/provider-selection-context.ts`,
      "utf8",
    );
    expect(selectionContextSource).toMatch(
      /AsyncLocalStorage<StartupProviderSelectionSnapshot>/u,
    );
    expect(selectionContextSource).not.toMatch(/process\.env/u);
    expect(providerSource).toMatch(/providerService\.environment\(\)/u);
    expect(providerSource).toMatch(/getCurrentRuntimeSession\(\)/u);
    expect(providerSource).not.toMatch(/peekAmbientRuntimeSession/u);
    expect(providerSource).not.toMatch(/process\.env/u);
    expect(providerSource).toMatch(
      /isGithubNativeAnthropicMode\(resolvedModel: string\)/u,
    );

    for (const path of [
      "utils/model/model.ts",
      "utils/model/openaiContextWindows.ts",
      "commands/status.ts",
    ]) {
      const source = readFileSync(`${SRC}/${path}`, "utf8");
      expect(source).not.toMatch(
        /process\.env\.(?:OPENAI|OPENAI_COMPATIBLE|GITHUB|GEMINI|MISTRAL|NVIDIA|MINIMAX|AWS_BEDROCK|ANTHROPIC).*MODEL/u,
      );
    }
    expect(existsSync(`${SRC}/utils/status.tsx`)).toBe(false);
    expect(
      readFileSync(`${SRC}/tui/startup/StatusNotices.tsx`, "utf8"),
    ).toMatch(/\.\/memoryDiagnostics\.js/u);

    const production = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .map((path) => readFileSync(path, "utf8"));
    expect(production.some((source) => /activeConfigModel/u.test(source))).toBe(
      false,
    );

    const contextWindowUpgrade = readFileSync(
      `${SRC}/llm/context-window-upgrade.ts`,
      "utf8",
    );
    expect(contextWindowUpgrade).toMatch(/getCurrentRuntimeSession\(\)/u);
    expect(contextWindowUpgrade).not.toMatch(
      /activeSnapshot|setContextWindowUpgradeContext/u,
    );
    expect(readFileSync(`${SRC}/bin/bootstrap.ts`, "utf8")).not.toMatch(
      /setContextWindowUpgradeContext/u,
    );
    expect(readFileSync(`${SRC}/session/session.ts`, "utf8")).not.toMatch(
      /setContextWindowUpgradeContext/u,
    );

    const startupSelection = readFileSync(
      `${SRC}/bin/startup-selection.ts`,
      "utf8",
    );
    expect(startupSelection).not.toMatch(
      /env\.(?:OPENAI_COMPATIBLE_MODEL|OPENAI_MODEL|AWS_BEDROCK_MODEL)/u,
    );

    const retiredModelSelector =
      /\b(?:OPENAI_MODEL|OPENAI_COMPATIBLE_MODEL|ANTHROPIC_MODEL|OLLAMA_MODEL|LMSTUDIO_MODEL|OPENROUTER_MODEL|GROQ_MODEL|DEEPSEEK_MODEL|GEMINI_MODEL|MISTRAL_MODEL|NVIDIA_MODEL|MINIMAX_MODEL|GITHUB_MODEL|AWS_BEDROCK_MODEL|ANTHROPIC_DEFAULT_(?:HAIKU|OPUS|SONNET)_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_CUSTOM_MODEL_OPTION|AGENC_SUBAGENT_MODEL|AGENC_AUTO_MODE_MODEL)\b/u;
    const retiredSelectorOffenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter((path) => !path.endsWith("/config/env.ts"))
      .filter((path) => retiredModelSelector.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(retiredSelectorOffenders).toEqual([]);

    const envSource = readFileSync(`${SRC}/config/env.ts`, "utf8");
    expect(envSource).toMatch(/OPENAI_MODEL: "AGENC_MODEL/u);
    expect(envSource).toMatch(/AWS_BEDROCK_MODEL: "AGENC_MODEL/u);
  });

  test("the test-only ambient provider binding cannot enter production code", () => {
    const hook = /enterStartupProviderSelectionForTestingOnly/u;
    const productionOffenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter((path) => !path.endsWith("/utils/model/providers.ts"))
      .filter((path) => hook.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    const testOffenders = sourceFiles(TESTS)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter(
        (path) =>
          !path.endsWith("/llm/provider-authority.architecture.test.ts"),
      )
      .filter((path) => hook.test(readFileSync(path, "utf8")))
      .map((path) => relative(TESTS, path));

    expect(productionOffenders).toEqual([]);
    expect(testOffenders).toEqual([]);
    const vitestSetup = readFileSync(`${RUNTIME}/vitest.setup.ts`, "utf8");
    expect(vitestSetup).toMatch(hook);

    const rawContextBindings = [
      /runWithStartupProviderSelectionSnapshot/u,
      /readStartupProviderSelectionSnapshot/u,
      /enterStartupProviderSelectionSnapshotForTests/u,
    ];
    for (const rawBinding of rawContextBindings) {
      const rawProductionOffenders = sourceFiles(SRC)
        .filter((path) => /\.(?:ts|tsx)$/.test(path))
        .filter(
          (path) =>
            !path.endsWith("/utils/model/provider-selection-context.ts") &&
            !path.endsWith("/utils/model/providers.ts"),
        )
        .filter((path) => rawBinding.test(readFileSync(path, "utf8")))
        .map((path) => relative(SRC, path));
      const rawTestOffenders = sourceFiles(TESTS)
        .filter((path) => /\.(?:ts|tsx)$/.test(path))
        .filter(
          (path) =>
            !path.endsWith("/llm/provider-authority.architecture.test.ts"),
        )
        .filter((path) => rawBinding.test(readFileSync(path, "utf8")))
        .map((path) => relative(TESTS, path));

      expect(rawProductionOffenders, rawBinding.source).toEqual([]);
      expect(rawTestOffenders, rawBinding.source).toEqual([]);
    }
    expect(vitestSetup).toMatch(
      /enterStartupProviderSelectionSnapshotForTests/u,
    );
  });

  test("secure provider credentials are never hydrated into process env", () => {
    for (const relative of [
      "utils/githubModelsCredentials.ts",
    ]) {
      const source = readFileSync(`${SRC}/${relative}`, "utf8");
      expect(source).not.toMatch(/hydrate.*FromSecureStorage/);
      expect(source).not.toMatch(
        /process\.env\.(?:GEMINI_ACCESS_TOKEN|GITHUB_TOKEN)\s*=/,
      );
    }
  });

  test("session auth helpers cannot rediscover secure-storage home from process env", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter((path) =>
        /resolveSecureStorageHome\(process\.env\)/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);

    const providerEnvironmentHomeOffenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .filter((path) =>
        /resolveSecureStorageHome\(getSelectedProviderEnvironment\(\)\)/u.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(SRC, path));
    expect(providerEnvironmentHomeOffenders).toEqual([]);
  });

  test("primary managed-key reads require an explicit home and have no global memo", () => {
    const source = readFileSync(`${SRC}/utils/auth.ts`, "utf8");
    expect(source).toMatch(
      /getPrimaryApiKeyFromSecureStorage\(\s*home: HomeContext/u,
    );
    expect(source).not.toMatch(
      /getPrimaryApiKeyFromSecureStorage\s*=\s*memoize/u,
    );
  });

  test("bootstrap cannot restore a duck-typed injected BYOK authority", () => {
    const source = readFileSync(`${SRC}/bin/bootstrap.ts`, "utf8");
    expect(source).not.toContain("AuthBackendWithLocalByokKeys");
    expect(source).not.toContain("canReadLocalByokKeys");
    expect(source).not.toMatch(
      /authBackend\s+as\s+\{\s*readByokKey\??\s*:/u,
    );
    expect(source).toMatch(
      /new LocalAuthBackend\(\{\s*agencHome,\s*env\s*\}\)/u,
    );
  });

  test("provider and web request paths cannot rediscover client env from process globals", () => {
    const directSessionEnvironment =
      /process\.env\.(?:(?:OPENAI|ANTHROPIC|GEMINI|MISTRAL|NVIDIA|MINIMAX|XAI|GROK|OLLAMA|LMSTUDIO|OPENROUTER|GROQ|DEEPSEEK|AWS_BEDROCK|GITHUB|GH|GOOGLE|AGENC_XAI)_[A-Z0-9_]+|(?:FIRECRAWL|BING|EXA|JINA|LINKUP|MOJEEK|TAVILY|YOU)_API_KEY|WEB_[A-Z0-9_]+)/u;
    const allowedIngress = new Set([
      "services/github/deviceFlow.ts",
      "utils/env.ts",
      "utils/user.ts",
    ]);
    const offenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/.test(path))
      .map((path) => ({
        name: relative(SRC, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ name, source }) =>
          !allowedIngress.has(name) && directSessionEnvironment.test(source),
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);

    const capturedKeys = new Set(CANONICAL_SESSION_ENV_KEYS);
    for (const key of [
      "FIRECRAWL_API_KEY",
      "BING_API_KEY",
      "EXA_API_KEY",
      "JINA_API_KEY",
      "LINKUP_API_KEY",
      "MOJEEK_API_KEY",
      "TAVILY_API_KEY",
      "YOU_API_KEY",
      "WEB_SEARCH_PROVIDER",
      "WEB_SEARCH_API",
      "WEB_HEADERS",
      "WEB_KEY",
    ]) {
      expect(capturedKeys).toContain(key);
    }
  });

  test("credential and provider endpoint process reads stay at named process ingresses", () => {
    const sensitiveProcessEnvironment =
      /process\.env\.(?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|ENDPOINT|BASE_URL|PROVIDER|MODEL)[A-Z0-9_]*)/u;
    const processIngresses = new Set([
      "constants/oauth.ts",
      "services/github/deviceFlow.ts",
      "utils/agencInChrome/mcpServer.ts",
      "utils/env.ts",
      "utils/ide.ts",
      "utils/user.ts",
    ]);
    const offenders = sourceFiles(SRC)
      .filter((path) => /\.(?:ts|tsx)$/u.test(path))
      .map((path) => ({
        name: relative(SRC, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ name, source }) =>
          !processIngresses.has(name) &&
          sensitiveProcessEnvironment.test(source),
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  test("selected-provider property reads are covered by the canonical daemon snapshot", () => {
    const capturedKeys = new Set<string>(CANONICAL_SESSION_ENV_KEYS);
    const reads = new Set<string>();
    for (const path of sourceFiles(SRC).filter((path) =>
      /\.(?:ts|tsx)$/u.test(path),
    )) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /getSelectedProviderEnvironment\(\)\.([A-Z][A-Z0-9_]*)/gu,
      )) {
        reads.add(match[1]!);
      }
      for (const binding of source.matchAll(
        /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*getSelectedProviderEnvironment\(\)/gu,
      )) {
        const name = binding[1]!;
        const propertyPattern = new RegExp(
          `\\b${name}\\.([A-Z][A-Z0-9_]*)`,
          "gu",
        );
        for (const property of source.matchAll(propertyPattern)) {
          reads.add(property[1]!);
        }
      }
    }
    expect([...reads].filter((key) => !capturedKeys.has(key)).sort()).toEqual(
      [],
    );
    expect(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS).toBe(CANONICAL_SESSION_ENV_KEYS);
    for (const forbidden of [
      "AGENC_HOME",
      "AGENC_CONFIG_DIR",
      "AGENC_WORKSPACE",
      "AGENC_DISABLE_EXPERIMENTAL_BETAS",
      "AGENC_SKIP_FAST_MODE_NETWORK_ERRORS",
      "AGENC_SKIP_FOUNDRY_AUTH",
      "AGENC_SKIP_VERTEX_AUTH",
      "ANTHROPIC_BETAS",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "ANTHROPIC_FOUNDRY_BASE_URL",
      "ANTHROPIC_FOUNDRY_RESOURCE",
      "ANTHROPIC_VERTEX_BASE_URL",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "GOOGLE_CLOUD_REGION",
      "USE_API_CONTEXT_MANAGEMENT",
      "VERTEX_BASE_URL",
    ]) {
      expect(capturedKeys).not.toContain(forbidden);
    }
  });

  test("provider-dependent TUI labels use captured session authority", () => {
    const capturedKeys = new Set(CANONICAL_SESSION_ENV_KEYS);
    expect(capturedKeys).toContain("AGENC_ONBOARDING");
    expect(capturedKeys).toContain("AGENC_DISABLE_1M_CONTEXT");
    expect(capturedKeys).toContain("AGENC_DISABLE_FAST_MODE");

    const fastModeSource = readFileSync(`${SRC}/utils/fastMode.ts`, "utf8");
    expect(fastModeSource).not.toContain("process.env");
    for (const retiredFastModeSurface of [
      "prefetchFastModeStatus",
      "resolveFastModeStatusFromCache",
      "onCooldownTriggered",
      "onCooldownExpired",
      "onFastModeOverageRejection",
      "onOrgFastModeChanged",
      "fast_mode_state",
    ]) {
      expect(fastModeSource).not.toContain(retiredFastModeSurface);
    }

    expect(existsSync(`${SRC}/tui/components/ModelPicker.tsx`)).toBe(false);
    expect(existsSync(`${SRC}/tui/components/FastIcon.tsx`)).toBe(false);
    expect(
      existsSync(`${SRC}/tui/components/PromptInput/useShowFastIconHint.ts`),
    ).toBe(false);
    const typecheckConfig = readFileSync(`${RUNTIME}/tsconfig.json`, "utf8");
    expect(typecheckConfig).not.toContain("tui/components/ModelPicker.tsx");
    expect(typecheckConfig).not.toContain("tui/components/FastIcon.tsx");
    for (const sdkSurface of [
      "entrypoints/sdk/coreSchemas.ts",
      "entrypoints/sdk/coreTypes.generated.ts",
    ]) {
      const source = readFileSync(`${SRC}/${sdkSurface}`, "utf8");
      expect(source).not.toContain("fast_mode_state");
      expect(source).not.toContain("FastModeState");
      expect(source).not.toContain("supportsFastMode");
    }
    for (const retiredCatalog of [
      "utils/model/modelOptions.ts",
      "utils/model/minimaxModels.ts",
      "utils/model/nvidiaNimModels.ts",
      "utils/model/ollamaModels.ts",
      "utils/model/copilotModels.ts",
      "utils/extraUsage.ts",
    ]) {
      expect(existsSync(`${SRC}/${retiredCatalog}`), retiredCatalog).toBe(false);
    }
    expect(
      readFileSync(`${SRC}/commands/config-context.ts`, "utf8"),
    ).not.toContain("providerNameFromCommandContext");

    for (const relativePath of [
      "tui/components/PromptInput/PromptInput.tsx",
      "tui/components/PromptInput/PromptInputHelpMenu.tsx",
    ]) {
      const source = readFileSync(`${SRC}/${relativePath}`, "utf8");
      expect(source).not.toMatch(
        /\b(?:getFastModeUnavailableReason|isFastModeAvailable|isFastModeCooldown|isFastModeEnabled|isFastModeSupportedByModel)\(/u,
      );
    }

    const statusBarSource = readFileSync(
      `${SRC}/tui/workbench/WorkbenchStatusBar.tsx`,
      "utf8",
    );
    expect(statusBarSource).toContain("renderModelNameForContext");
    expect(statusBarSource).not.toMatch(/\brenderModelName\(/u);

    const appSource = readFileSync(`${SRC}/tui/components/App.tsx`, "utf8");
    expect(appSource).toMatch(
      /modelDisplayContext=\{remoteAuthSessionContext\}/u,
    );
    expect(appSource).not.toContain("getRuntimeMainLoopModel");
    expect(appSource).not.toContain("mainLoopModelSetting");
    expect(appSource).toMatch(
      /getContextWindowForModelForContext\([\s\S]*?remoteAuthSessionContext/u,
    );

    const modelSource = readFileSync(`${SRC}/utils/model/model.ts`, "utf8");
    expect(modelSource).not.toContain("getRuntimeMainLoopModel");
    expect(modelSource).not.toContain("opusplan");
    expect(modelSource).not.toContain("agencplan");
    expect(modelSource).not.toContain("agencspark");

    expect(
      getContextWindowForModelForContext(
        "unknown-local-model",
        {
          provider: "openai-compatible",
          environment: {
            AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW: "777777",
          },
        },
      ),
    ).toBe(777_777);
    expect(
      getContextWindowForModelForContext(
        "claude-sonnet-4-6[1m]",
        {
          provider: "anthropic",
          environment: { AGENC_DISABLE_1M_CONTEXT: "1" },
        },
      ),
    ).not.toBe(1_000_000);

    const effortIndicatorSource = readFileSync(
      `${SRC}/tui/components/EffortIndicator.ts`,
      "utf8",
    );
    expect(effortIndicatorSource).toContain(
      "modelSupportsEffortForContext",
    );
    expect(effortIndicatorSource).toContain(
      "getDisplayedEffortLevelForContext",
    );
    expect(effortIndicatorSource).not.toMatch(
      /\b(?:modelSupportsEffort|getDisplayedEffortLevel)\(/u,
    );

    const spinnerSource = readFileSync(
      `${SRC}/tui/components/spinner/Spinner.tsx`,
      "utf8",
    );
    expect(spinnerSource).toContain("getEffortSuffixForContext");
    expect(spinnerSource).not.toMatch(
      /\b(?:getEffortSuffix|getMainLoopModel)\(/u,
    );
  });
});
