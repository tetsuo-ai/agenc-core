import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

describe("native secure storage authority", () => {
  test("Linux credential CRUD uses one exact-item helper surface", () => {
    const adapter = readFileSync(
      join(ROOT, "utils", "secureStorage", "linuxSecretStorage.ts"),
      "utf8",
    );
    const helper = readFileSync(
      join(ROOT, "..", "native", "agenc-secret-service-helper.c"),
      "utf8",
    );

    expect(adapter).toContain("agenc-secret-service-helper");
    expect(adapter).not.toContain("secret-tool");
    expect(helper).toContain("SECRET_SEARCH_ALL");
    expect(helper).toContain("item_set_secret_sync");
    expect(helper).toContain("item_delete_sync");
    expect(helper).not.toContain("secret_service_clear_sync");
    expect(helper).not.toContain("secret_service_store_sync");
  });

  test("ordinary runtime selection has no plaintext fallback", () => {
    const source = readFileSync(
      join(ROOT, "utils", "secureStorage", "index.ts"),
      "utf8",
    );
    expect(source).not.toContain("plainTextStorage");
    expect(source).not.toContain("createFallbackStorage");
    expect(source).not.toContain("allowPlainTextFallback");
    expect(source).not.toContain("resolveHomeContext");
    expect(source).not.toContain("process.env");
    expect(source).toContain("home: HomeContext");
  });

  test("native secure storage operations and adapters stay bound to explicit HomeContext", () => {
    const native = readFileSync(
      join(ROOT, "utils", "secureStorage", "native.ts"),
      "utf8",
    );
    const platformSources = [
      "macOsKeychainHelpers.ts",
      "macOsKeychainStorage.ts",
      "linuxSecretStorage.ts",
      "windowsCredentialStorage.ts",
    ].map((name) =>
      readFileSync(join(ROOT, "utils", "secureStorage", name), "utf8")
    );

    expect(native).not.toContain("resolveHomeContext");
    expect(native).not.toContain("process.env");
    for (const source of platformSources) {
      expect(source).not.toContain("process.env.AGENC_HOME");
      expect(source).not.toContain("getAgenCHomeDir");
      expect(source).not.toContain("resolveHomeContext");
    }
  });

  test("OAuth runtime never watches or reads the retired credential file", () => {
    const source = readFileSync(join(ROOT, "utils", "auth.ts"), "utf8");
    expect(source).not.toContain(".credentials.json");
    expect(source).not.toContain("invalidateOAuthCacheIfDiskChanged");
  });

  test("auth backends and remote subprocess auth have no plaintext secret authority", () => {
    const local = readFileSync(
      join(ROOT, "auth", "backends", "local.ts"),
      "utf8",
    );
    const remote = readFileSync(
      join(ROOT, "auth", "backends", "remote.ts"),
      "utf8",
    );
    const descriptor = readFileSync(
      join(ROOT, "utils", "authFileDescriptor.ts"),
      "utf8",
    );
    const ingress = readFileSync(
      join(ROOT, "utils", "sessionIngressAuth.ts"),
      "utf8",
    );

    expect(local).not.toContain("byok-keys.json");
    expect(local).not.toContain("byokKeys?.[");
    expect(remote).not.toMatch(/readRemoteAuthState\([^)]*\)[\s\S]{0,80}\.token/u);
    for (const source of [descriptor, ingress]) {
      expect(source).not.toContain(".oauth_token");
      expect(source).not.toContain(".api_key");
      expect(source).not.toContain(".session_ingress_token");
      expect(source).not.toContain("AGENC_REMOTE_TOKEN_DIR");
      expect(source).not.toContain("AGENC_SESSION_INGRESS_TOKEN_FILE");
      expect(source).not.toContain("writeFileSync");
    }
  });

  test("ProviderCode OAuth writes use explicit-home native RMW", () => {
    const credentials = readFileSync(
      join(ROOT, "utils", "openAiOauthCredentials.ts"),
      "utf8",
    );

    expect(credentials).toContain("updateNativeSecureStorage(");
    expect(credentials).toContain("readNativeSecureStorage(home)");
    expect(credentials).toContain("readNativeSecureStorageAsync(home)");
    expect(credentials).not.toContain("getSecureStorage(");
    expect(credentials).not.toContain("resolveSecureStorageHome");
  });

  test("provider credential authorities use explicit-home native reads and serialized RMW", () => {
    const providerSources = [
      "githubModelsCredentials.ts",
      "xaiOauthCredentials.ts",
    ].map((name) =>
      readFileSync(join(ROOT, "utils", name), "utf8")
    );
    const auth = readFileSync(join(ROOT, "utils", "auth.ts"), "utf8");
    const agencAiOauthSection = auth.slice(
      auth.indexOf("type StoredAgenCAIOauth"),
      auth.indexOf("export const getproviderApiKey"),
    );

    for (const source of providerSources) {
      expect(source).toContain("HomeContext");
      expect(source).toContain("readNativeSecureStorage");
      expect(source).toContain("updateNativeSecureStorage(");
      expect(source).not.toContain("getSecureStorage(");
      expect(source).not.toContain("getAgenCHomeDir");
      expect(source).not.toContain("resolveSecureStorageHome");
    }
    expect(auth).toContain(
      "const readPersistedAgenCAIOAuthTokens = memoize((home: HomeContext)",
    );
    expect(auth).toContain("}, secureStorageIdentityKey)");
    expect(auth).toContain(
      "export function getAgenCAIOAuthTokens(\n  home: HomeContext,\n  environment: ProviderEnvironment,",
    );
    const tokenReader = auth.slice(
      auth.indexOf("export function getAgenCAIOAuthTokens("),
      auth.indexOf("function clearAgenCAIOAuthTokenCache"),
    );
    expect(tokenReader).not.toContain("getSelectedProviderEnvironment");
    expect(tokenReader).not.toContain("process.env");
    expect(auth).toContain("const pendingRefreshChecks = new Map<string");
    expect(auth).toContain("join(home.path, '.agenc-ai-oauth-refresh')");
    expect(auth).toContain("writeAgenCAIOAuthTokens(home, refreshedTokens, lockedTokens)");
    expect(auth).not.toContain("getSecureStorage(");
    expect(auth).not.toContain("getAgenCHomeDir");
    expect(agencAiOauthSection).not.toContain("currentNativeHome(");
    expect(agencAiOauthSection).not.toContain("resolveSecureStorageHome");
  });

  test("credential caches use the complete native secure storage identity", () => {
    const cacheAuthorities = [
      "auth.ts",
      "openAiOauthCredentials.ts",
      "githubModelsCredentials.ts",
      "xaiOauthCredentials.ts",
      "authFileDescriptor.ts",
      "sessionIngressAuth.ts",
    ].map((name) => readFileSync(join(ROOT, "utils", name), "utf8"));
    const mcpClient = readFileSync(
      join(ROOT, "services", "mcp", "client.ts"),
      "utf8",
    );

    for (const source of [...cacheAuthorities, mcpClient]) {
      expect(source).toContain("secureStorageIdentityKey");
    }
  });

  test("only the native secure storage implementation accesses storage directly", () => {
    const directCallers = sourceFiles(ROOT)
      .filter((path) => readFileSync(path, "utf8").includes("getSecureStorage("))
      .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
      .sort();

    expect(directCallers).toEqual([
      "utils/secureStorage/index.ts",
      "utils/secureStorage/native.ts",
    ]);
  });

  test("only explicit config migration may open a retired native secure storage identity", () => {
    const callers = sourceFiles(ROOT)
      .filter((path) =>
        readFileSync(path, "utf8").includes("getSecureStorageForMigration(")
      )
      .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
      .sort();

    expect(callers).toEqual([
      "config/migration.ts",
      "utils/secureStorage/index.ts",
    ]);
  });

  test("MCP OAuth and XAA credentials require explicit home-bound native RMW", () => {
    const auth = readFileSync(
      join(ROOT, "services", "mcp", "auth.ts"),
      "utf8",
    );
    const xaa = readFileSync(
      join(ROOT, "services", "mcp", "xaaIdpLogin.ts"),
      "utf8",
    );
    const client = readFileSync(
      join(ROOT, "services", "mcp", "client.ts"),
      "utf8",
    );

    for (const source of [auth, xaa]) {
      expect(source).toContain("readNativeSecureStorage(");
      expect(source).toContain("updateNativeSecureStorage(");
      expect(source).not.toContain("getSecureStorage(");
      expect(source).not.toMatch(/\.read\(\)\s*;?[\s\S]{0,200}\.update\(/u);
    }
    expect(auth).toContain("home: HomeContext,");
    expect(auth).toContain("private readonly home: HomeContext");
    expect(xaa).toContain("home: HomeContext");
    expect(xaa).toContain(
      "isXaaEnabled(environment: ProviderEnvironment)",
    );
    expect(xaa).not.toContain("process.env.AGENC_ENABLE_XAA");
    expect(auth).not.toContain("isXaaEnabled()");
    expect(client).not.toContain("isXaaEnabled()");
    expect(client).toContain("requires an explicit HomeContext");
  });
});
