import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const RUNTIME_ROOT = resolve(import.meta.dirname, "../..");

function source(relativePath: string): string {
  return readFileSync(resolve(RUNTIME_ROOT, relativePath), "utf8");
}

describe("sandbox schema authority", () => {
  test("has no competing entrypoint schema", () => {
    expect(
      existsSync(resolve(RUNTIME_ROOT, "src/entrypoints/sandboxTypes.ts")),
    ).toBe(false);
    const sdkTypes = source("src/entrypoints/sdk/coreTypes.ts");
    expect(sdkTypes).toContain("from '../../config/schema.js'");
    expect(sdkTypes).not.toContain("sandboxTypes");
    expect(sdkTypes).not.toContain("SandboxSettings");
  });

  test("keeps the canonical sandbox shape closed and explicitly typed", () => {
    const schema = source("src/config/schema.ts");
    const sandboxShape = schema.slice(
      schema.indexOf("export interface SandboxNetworkConfig"),
      schema.indexOf("export interface ShellEnvironmentPolicy"),
    );
    expect(sandboxShape).toContain("readonly network?: SandboxNetworkConfig");
    expect(sandboxShape).toContain(
      "readonly filesystem?: SandboxFilesystemConfig",
    );
    expect(sandboxShape).toContain("readonly ripgrep?: SandboxRipgrepConfig");
    expect(sandboxShape).not.toContain("Record<string, unknown>");
    expect(sandboxShape).not.toContain("[key: string]");
    expect(sandboxShape).not.toContain("enabledPlatforms");
    expect(sandboxShape).not.toContain("argv0");
  });

  test("sandbox runtime consumes canonical types without projection casts", () => {
    const runtime = source("src/utils/sandbox/sandbox-runtime.ts");
    expect(runtime).toContain("SandboxFilesystemConfig");
    expect(runtime).toContain("SandboxNetworkConfig");
    expect(runtime).not.toMatch(
      /interface Sandbox(?:Network|Filesystem|Ripgrep)Settings/u,
    );
    expect(runtime).not.toContain("enabledPlatforms");
    expect(runtime).not.toMatch(/sandbox[^\n]* as \{/u);
    expect(runtime).not.toMatch(/ripgrep[^\n]* as Sandbox/u);
  });

  test("documents exact nested fields instead of open passthrough maps", () => {
    const reference = source("../docs/reference/config.md");
    expect(reference).not.toMatch(/sandbox\.(?:network|filesystem|ripgrep).*Open /u);
    for (const path of [
      "sandbox.network.allowedDomains",
      "sandbox.network.httpProxyPort",
      "sandbox.network.socksProxyPort",
      "sandbox.filesystem.allowManagedReadPathsOnly",
      "sandbox.ignoreViolations.<name>",
      "sandbox.ripgrep.command",
      "sandbox.ripgrep.args",
    ]) {
      expect(reference).toContain(`\`${path}\``);
    }
  });
});
