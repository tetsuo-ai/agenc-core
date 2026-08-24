import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DAEMON_CLIENT_ENV_SNAPSHOT_KEYS } from "../../src/app-server/client-env-snapshot.js";
import { CANONICAL_SESSION_ENV_KEYS } from "../../src/session/environment.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const TESTS = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../../", import.meta.url));
const OBSOLETE_SELECTOR_FIXTURES = new Set([
  "config/canonical-repository.test.ts",
  "config/env-documentation-coverage.architecture.test.ts",
  "app-server/agent-lifecycle.contract.test.ts",
  "app-server/client-env-snapshot.test.ts",
  "llm/provider-authority.architecture.test.ts",
  "session/provider-service.test.ts",
]);

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(`${path}/${entry}`));
}

describe("provider authority architecture", () => {
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
      "llm/_deps/config.ts",
      "llm/registry/provider-info.ts",
      "llm/model-registry.ts",
      "llm/model-metadata.ts",
      "llm/api/fallback-ladder.ts",
      "llm/capabilities.ts",
    ]) {
      const source = readFileSync(`${SRC}/${path}`, "utf8");
      expect(source).toMatch(
        /normalizeProviderIdentity|resolveBuiltInProviderSlug|resolveProviderSlug/u,
      );
    }
  });

  test("the provider factory is deterministic from its arguments", () => {
    const source = readFileSync(`${SRC}/llm/provider.ts`, "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/resolveProviderNameFromEnv/);
    expect(existsSync(`${SRC}/utils/providerValidation.ts`)).toBe(false);
  });

  test("production code cannot consume, generate, or forward obsolete selectors", () => {
    const obsoleteSelector =
      /\b(?:AGENC_USE_(?:OPENAI|GEMINI|MISTRAL|GITHUB|MINIMAX|BEDROCK|VERTEX|FOUNDRY)|NVIDIA_NIM)\b/;
    const offenders = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .filter((path) => !path.endsWith("/config/env.ts"))
      .filter((path) => obsoleteSelector.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
    const envSource = readFileSync(`${SRC}/config/env.ts`, "utf8");
    const snapshot =
      envSource.match(/export interface EnvSnapshot \{([\s\S]*?)\n\}/u)?.[1] ??
      "";
    expect(snapshot).not.toMatch(obsoleteSelector);
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

  test("behavioral tests cannot install obsolete provider selectors", () => {
    const obsoleteSelector =
      /\b(?:AGENC_USE_(?:OPENAI|GEMINI|MISTRAL|GITHUB|MINIMAX|BEDROCK|VERTEX|FOUNDRY)|NVIDIA_NIM)\b/;
    const offenders = sourceFiles(TESTS)
      .filter((path) => /\.(?:mjs|ts|tsx)$/.test(path))
      .flatMap((path) => {
        const name = relative(TESTS, path);
        if (OBSOLETE_SELECTOR_FIXTURES.has(name)) return [];
        return obsoleteSelector.test(readFileSync(path, "utf8")) ? [name] : [];
      });
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
    expect(providerSource).toMatch(
      /AsyncLocalStorage<ProviderRuntimeSelection>/u,
    );
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
      "utils/status.tsx",
      "services/api/providerConfig.ts",
      "services/api/openaiShim.ts",
    ]) {
      const source = readFileSync(`${SRC}/${path}`, "utf8");
      expect(source).not.toMatch(
        /process\.env\.(?:OPENAI|OPENAI_COMPATIBLE|GITHUB|GEMINI|MISTRAL|NVIDIA|MINIMAX|AWS_BEDROCK|ANTHROPIC).*MODEL/u,
      );
    }

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
    const hook = /enterStartupProviderSelectionForTestingOnly/;
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
    expect(readFileSync(`${RUNTIME}/vitest.setup.ts`, "utf8")).toMatch(hook);
  });

  test("secure provider credentials are never hydrated into process env", () => {
    for (const relative of [
      "utils/geminiCredentials.ts",
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
    ]) {
      expect(capturedKeys).not.toContain(forbidden);
    }
  });

  test("provider-dependent TUI labels and fast mode use captured session authority", () => {
    const capturedKeys = new Set(CANONICAL_SESSION_ENV_KEYS);
    expect(capturedKeys).toContain("AGENC_DISABLE_FAST_MODE");
    expect(capturedKeys).toContain("AGENC_SKIP_FAST_MODE_NETWORK_ERRORS");

    const fastModeSource = readFileSync(`${SRC}/utils/fastMode.ts`, "utf8");
    expect(fastModeSource).not.toContain("process.env");

    for (const relativePath of [
      "tui/components/ModelPicker.tsx",
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
  });
});
