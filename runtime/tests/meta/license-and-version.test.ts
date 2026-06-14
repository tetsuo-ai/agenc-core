import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const repoRoot = new URL("../../../", import.meta.url).pathname;

function readRepoFile(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

describe("repository licensing", () => {
  test("a root LICENSE file exists", () => {
    expect(existsSync(`${repoRoot}LICENSE`)).toBe(true);
  });

  test("LICENSE is MIT and carries a copyright line", () => {
    const license = readRepoFile("LICENSE");
    expect(license).toContain("MIT License");
    expect(license).toMatch(/^Copyright \(c\) \d{4} .+/m);
  });

  test("packages/agenc/package.json declares the MIT license", () => {
    const pkg = JSON.parse(readRepoFile("packages/agenc/package.json")) as {
      license?: string;
    };
    expect(pkg.license).toBe("MIT");
  });

  test("runtime/package.json declares the MIT license", () => {
    const pkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      license?: string;
    };
    expect(pkg.license).toBe("MIT");
  });
});

describe("build-time MACRO.VERSION wiring", () => {
  // MACRO.VERSION is injected at build time via esbuild `define`.
  // We cannot exercise the bundled define from a unit test, so instead we
  // assert the build config no longer hardcodes a fake version and that it
  // sources the real version from runtime/package.json.
  test("build.config.ts does not hardcode the fake 99.0.0 version", () => {
    const buildConfig = readRepoFile("runtime/build.config.ts");
    expect(buildConfig).not.toContain("99.0.0");
  });

  test("MACRO.VERSION is defined from the package.json-derived version", () => {
    const buildConfig = readRepoFile("runtime/build.config.ts");
    expect(buildConfig).toMatch(
      /'MACRO\.VERSION':\s*JSON\.stringify\(displayVersion\)/,
    );
  });

  test("the version source matches runtime/package.json", () => {
    const buildConfig = readRepoFile("runtime/build.config.ts");
    // displayVersion is read from runtime/package.json's `version` field.
    expect(buildConfig).toContain("runtimePackage.version");
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      version?: string;
    };
    expect(runtimePkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
