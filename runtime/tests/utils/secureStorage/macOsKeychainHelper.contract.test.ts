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
    expect(source).toContain("kSecReturnPersistentRef");
    expect(source).toContain("kSecMatchItemList");
    expect(source).toContain("copy_unique_persistent_ref");
    expect(source).toContain("copy_item_by_persistent_ref");
    expect(source).toContain("SecKeychainAttribute attributes[2]");
    expect(source).toContain("attributes[0].tag = kSecServiceItemAttr");
    expect(source).toContain("attributes[1].tag = kSecAccountItemAttr");
    expect(source).toContain("attribute_list.count = 2U");
    expect(source).toContain("SecKeychainSearchCreateFromAttributes(");
    expect(source).toContain("SecKeychainSearchCopyNext(search, &item)");
    expect(source).toContain("keychain_index < CFArrayGetCount(search_list)");
    expect(source).toContain("SecKeychainItemCopyKeychain(item, &owner)");
    expect(source).toContain("!CFEqual(owner, keychain)");
    expect(source).toContain(
      "SecKeychainItemCreatePersistentReference(item, &candidate)",
    );
    expect(source).toContain("CFStringGetCString((CFStringRef)service_value");
    expect(source).toContain("CFStringGetCString((CFStringRef)account_value");
    expect(source).toContain("capture_unique_persistent_ref");
    expect(source).toContain("CFEqual(*captured_out, candidate)");
    expect(source).toContain(
      "multiple Keychain records match the exact service/account identity",
    );
    expect(source).not.toContain("SecKeychainFindGenericPassword(");
    expect(source).toContain("SecItemUpdate(query, values)");
    expect(source).toContain(
      "if (result != HELPER_OK) {\n    return result;\n  }\n  result = HELPER_ERROR;",
    );
    expect(source).toContain("kSecPreferencesDomainUser");
    expect(source).toContain("SecKeychainCopyDomainDefault(");
    expect(source).toContain("if (status == errSecNoDefaultKeychain)");
    expect(source).toContain(
      "(status != errSecSuccess) && (status != errSecNoDefaultKeychain)",
    );
    expect(source).toContain("SecKeychainCopyDomainSearchList(");
    expect(source.match(/SecKeychainCopyDomainSearchList/gu)).toHaveLength(1);
    expect(source).toContain(
      "CFDictionarySetValue(query, kSecMatchSearchList, search_list)",
    );
    expect(source).toContain("CFArrayGetCount(search_list) != 1");
    expect(source).toContain("CFArrayContainsValue(");
    expect(source).toContain(
      "CFDictionaryRemoveValue(item, kSecMatchSearchList)",
    );
    expect(source).toContain(
      "CFDictionarySetValue(item, kSecUseKeychain, target)",
    );
    expect(source).toContain("SecItemAdd(item, added_out)");
    expect(source).toContain("SecItemDelete(query)");
    expect(source).toContain("status == errSecDuplicateItem");
    expect(source).toContain("status == errSecItemNotFound");
    expect(source).toContain("HELPER_NOT_FOUND = 2");
    expect(source).toContain("SecCopyErrorMessageString(status, NULL)");
    expect(source).toContain("kCFStringEncodingUTF8");

    expect(source).not.toContain("SecItemUpdate(identity_query");
    expect(source).not.toContain("SecItemDelete(identity_query");
    expect(
      source.match(/create_item_list_query\(persistent_ref\)/gu),
    ).toHaveLength(1);
    const itemListQueryIndex = source.indexOf(
      "static CFMutableDictionaryRef create_item_list_query(CFTypeRef item)",
    );
    const itemListClassIndex = source.indexOf(
      "CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword)",
      itemListQueryIndex,
    );
    const itemListIndex = source.indexOf(
      "CFDictionarySetValue(query, kSecMatchItemList, item_list)",
      itemListClassIndex,
    );
    expect(itemListQueryIndex).toBeGreaterThan(0);
    expect(itemListClassIndex).toBeGreaterThan(itemListQueryIndex);
    expect(itemListIndex).toBeGreaterThan(itemListClassIndex);

    const exactConversionIndex = source.indexOf(
      "copy_item_by_persistent_ref(CFDataRef persistent_ref",
    );
    const returnRefIndex = source.indexOf(
      "CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue)",
      exactConversionIndex,
    );
    const convertedItemIndex = source.indexOf(
      "SecItemCopyMatching(query, &matched)",
      returnRefIndex,
    );
    const exactDataIndex = source.indexOf(
      "copy_data_by_persistent_ref(CFDataRef persistent_ref",
      convertedItemIndex,
    );
    const transientItemQueryIndex = source.indexOf(
      "query = create_item_list_query(item)",
      exactDataIndex,
    );
    const returnDataIndex = source.indexOf(
      "CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue)",
      transientItemQueryIndex,
    );
    expect(exactConversionIndex).toBeGreaterThan(0);
    expect(returnRefIndex).toBeGreaterThan(exactConversionIndex);
    expect(convertedItemIndex).toBeGreaterThan(returnRefIndex);
    expect(exactDataIndex).toBeGreaterThan(convertedItemIndex);
    expect(transientItemQueryIndex).toBeGreaterThan(exactDataIndex);
    expect(returnDataIndex).toBeGreaterThan(transientItemQueryIndex);

    const defaultLookupIndex = source.indexOf(
      "SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &target)",
    );
    const targetIndex = source.indexOf(
      "CFDictionarySetValue(item, kSecUseKeychain, target)",
      defaultLookupIndex,
    );
    const removeMatchListIndex = source.indexOf(
      "CFDictionaryRemoveValue(item, kSecMatchSearchList)",
      defaultLookupIndex,
    );
    const addIndex = source.indexOf("SecItemAdd(item, added_out)", targetIndex);
    const duplicateIndex = source.indexOf(
      "status == errSecDuplicateItem",
      addIndex,
    );
    const retryIndex = source.indexOf("continue;", duplicateIndex);
    expect(defaultLookupIndex).toBeGreaterThan(0);
    expect(removeMatchListIndex).toBeGreaterThan(defaultLookupIndex);
    expect(targetIndex).toBeGreaterThan(defaultLookupIndex);
    expect(targetIndex).toBeGreaterThan(removeMatchListIndex);
    expect(addIndex).toBeGreaterThan(targetIndex);
    expect(duplicateIndex).toBeGreaterThan(addIndex);
    expect(retryIndex).toBeGreaterThan(duplicateIndex);

    const operationIndex = source.indexOf(
      "parse_operation(argv[1], &operation)",
    );
    const searchListIndex = source.indexOf(
      "copy_user_keychain_search_list(&user_search_list)",
    );
    expect(operationIndex).toBeGreaterThan(0);
    expect(searchListIndex).toBeGreaterThan(operationIndex);
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
    expect(source).toContain("#define __STDC_WANT_LIB_EXT1__ 1");
    expect(source).toContain("(void)memset_s(buffer, length, 0, length)");
    expect(source).toContain(
      "clear_secret_bytes(secret->data, secret->length)",
    );
    expect(
      source.match(/clear_secret_bytes\(buffer, length\);/gu),
    ).toHaveLength(2);
    expect(source).not.toContain("explicit_bzero");
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
