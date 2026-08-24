import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const runtimeRoot = resolve(import.meta.dirname, "../../..");

function runtimeFile(path: string): string {
  return readFileSync(resolve(runtimeRoot, path), "utf8");
}

describe("macOS Keychain native-helper contract", () => {
  test("owns exact generic-password CRUD and reserves exit 2 for exact absence", () => {
    const source = runtimeFile("native/agenc-keychain-helper.c");

    expect(source).toContain("kSecClassGenericPassword");
    expect(source).toContain("kSecAttrService");
    expect(source).toContain("kSecAttrAccount");
    expect(source).toContain("kSecMatchLimitAll");
    expect(source).toContain("kSecReturnPersistentRef");
    expect(source).toContain("kSecMatchItemList");
    expect(source).toContain("copy_unique_persistent_ref");
    expect(source).toContain("count != 1");
    expect(source).toContain(
      "multiple Keychain records match the exact service/account identity",
    );
    expect(source).toContain("SecItemUpdate(query, values)");
    expect(source).toContain("SecItemAdd(item, &added)");
    expect(source).toContain("SecItemDelete(query)");
    expect(source).toContain("status == errSecDuplicateItem");
    expect(source).toContain("status == errSecItemNotFound");
    expect(source).toContain("HELPER_NOT_FOUND = 2");
    expect(source).toContain("SecCopyErrorMessageString(status, NULL)");
    expect(source).toContain("kCFStringEncodingUTF8");

    expect(source).not.toContain("SecItemUpdate(identity_query");
    expect(source).not.toContain("SecItemDelete(identity_query");

    const addIndex = source.indexOf("SecItemAdd(item, &added)");
    const duplicateIndex = source.indexOf(
      "status == errSecDuplicateItem",
      addIndex,
    );
    const retryIndex = source.indexOf("continue;", duplicateIndex);
    expect(addIndex).toBeGreaterThan(0);
    expect(duplicateIndex).toBeGreaterThan(addIndex);
    expect(retryIndex).toBeGreaterThan(duplicateIndex);
  });

  test("verifies exact bytes and unique identity after every successful write", () => {
    const source = runtimeFile("native/agenc-keychain-helper.c");

    expect(source).toContain("verify_data_by_persistent_ref");
    expect(source).toContain("CFEqual(observed, expected)");
    expect(source).toContain("verify_unique_identity_ref");
    expect(source).toContain("CFEqual(observed_ref, expected_ref)");
    expect(source).toContain("attempt < 3U");
    expect(source).toContain("delete_by_persistent_ref(persistent_ref)");
    expect(source).toContain("Keychain add rollback");
  });

  test("keeps secret bytes off argv, bounds input, and clears owned input memory", () => {
    const source = runtimeFile("native/agenc-keychain-helper.c");

    expect(source).toContain("fread(buffer + length");
    expect(source).toContain("fwrite(bytes + offset");
    expect(source).toContain(
      "#define SECRET_LIMIT_BYTES ((size_t)16U * 1024U * 1024U)",
    );
    expect(source).toContain("length >= SECRET_LIMIT_BYTES");
    expect(source).toContain("explicit_bzero(secret->data, secret->length)");
    expect(source).not.toMatch(/system\s*\(/u);
    expect(source).not.toMatch(/popen\s*\(/u);
    expect(source).not.toContain("/usr/bin/security");
    expect(source).not.toContain("find-generic-password");
    expect(source).not.toContain("add-generic-password");
    expect(source).not.toContain("argv[4]");
  });

  test("bundles the helper with the macOS Security frameworks and executable mode", () => {
    const build = runtimeFile("build.config.ts");
    const entrypointCheck = runtimeFile(
      "scripts/check-package-entrypoints.mjs",
    );
    const manifest = JSON.parse(runtimeFile("package.json")) as {
      agencExecutableFiles: string[];
    };

    expect(build).toContain("native/agenc-keychain-helper.c");
    expect(build).toContain("dist/agenc-keychain-helper");
    expect(build).toContain("function compileMacOsKeychainHelper()");
    expect(build).toContain("compileMacOsKeychainHelper();");
    expect(build).toMatch(/'-framework',\s*'Security'/u);
    expect(build).toMatch(/'-framework',\s*'CoreFoundation'/u);
    expect(build).toContain("chmodSync(macOsKeychainHelperDist, 0o755)");
    expect(manifest.agencExecutableFiles).toContain(
      "dist/agenc-keychain-helper",
    );
    expect(entrypointCheck).toContain(
      'process.platform === "darwin" ? ["dist/agenc-keychain-helper"] : []',
    );
  });

  test("runtime credential CRUD invokes only the bundled helper", () => {
    const adapter = runtimeFile(
      "src/utils/secureStorage/macOsKeychainStorage.ts",
    );

    expect(adapter).toContain("resolveBundledSecureStorageHelper");
    expect(adapter).toContain("SECURE_STORAGE_HELPER_PAYLOAD_LIMIT_BYTES");
    expect(adapter).not.toContain("const KEYCHAIN_HELPER_PAYLOAD_LIMIT_BYTES");
    expect(adapter).toMatch(/["']read["'], storageServiceName, username/u);
    expect(adapter).toMatch(/["']write["'], storageServiceName, username/u);
    expect(adapter).toMatch(/["']delete["'], storageServiceName, username/u);
    expect(adapter).not.toContain("find-generic-password");
    expect(adapter).not.toContain("add-generic-password");
    expect(adapter).not.toContain("delete-generic-password");
    expect(adapter).not.toContain("MACOS_SECURITY_PATH, ['-i']");
  });
});
