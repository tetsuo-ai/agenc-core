import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const runtimeRoot = resolve(import.meta.dirname, "../../..");

function runtimeFile(path: string): string {
  return readFileSync(resolve(runtimeRoot, path), "utf8");
}

describe("Linux Secret Service native-helper contract", () => {
  test("creates without replacement and verifies the exact item and payload", () => {
    const source = runtimeFile("native/agenc-secret-service-helper.c");

    expect(source).toContain("SECRET_SEARCH_ALL");
    expect(source).toContain("SECRET_ITEM_CREATE_NONE");
    expect(source).not.toContain("SECRET_ITEM_CREATE_REPLACE");
    expect(source).toMatch(
      /item_create_sync\([\s\S]*SECRET_ITEM_CREATE_NONE, NULL, &error\)/u,
    );
    expect(source).toContain('"g_dbus_proxy_get_object_path"');
    expect(source).toContain("verify_item_payload(");
    expect(source).toContain("actual_payload_length != expected_payload_length");
    expect(source).toContain(
      "difference |= (unsigned char)actual_payload[index]",
    );
  });

  test("fails closed without restoring a stale pre-update value", () => {
    const source = runtimeFile("native/agenc-secret-service-helper.c");

    expect(source).not.toContain("previous_value");
    expect(source).not.toContain("rollback");
    expect(source).toContain("verification.count != 1U");
    expect(source).toContain("remove_unverified_created_item(context, created)");
    expect(source).toContain("item_delete_sync(search.item");
    expect(source).not.toContain("secret_service_clear_sync");
    expect(source).not.toContain("secret_service_store_sync");
  });

  test("keeps secret bytes off argv, bounds input, and clears owned memory", () => {
    const source = runtimeFile("native/agenc-secret-service-helper.c");

    expect(source).toContain("fread(buffer + length");
    expect(source).toContain("fwrite(data + written");
    expect(source).toContain("#define MAX_SECRET_BYTES (16U * 1024U * 1024U)");
    expect(source).toContain("length >= MAX_SECRET_BYTES");
    expect(source).toContain("explicit_bzero(payload, payload_length)");
    expect(source).not.toMatch(/system\s*\(/u);
    expect(source).not.toMatch(/popen\s*\(/u);
  });

  test("bundles the helper as a required executable Linux asset", () => {
    const build = runtimeFile("build.config.ts");
    const entrypointCheck = runtimeFile(
      "scripts/check-package-entrypoints.mjs",
    );
    const manifest = JSON.parse(runtimeFile("package.json")) as {
      agencExecutableFiles: string[];
    };

    expect(build).toContain("native/agenc-secret-service-helper.c");
    expect(build).toContain("dist/agenc-secret-service-helper");
    expect(build).toContain("function compileLinuxSecretServiceHelper()");
    expect(build).toContain("compileLinuxSecretServiceHelper();");
    expect(build).toContain(
      "chmodSync(linuxSecretServiceHelperDist, 0o755)",
    );
    expect(manifest.agencExecutableFiles).toContain(
      "dist/agenc-secret-service-helper",
    );
    expect(entrypointCheck).toContain(
      'process.platform === "linux" ? ["dist/agenc-secret-service-helper"] : []',
    );
  });
});
