import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolvePinnedRipgrepPath,
  selectPinnedRipgrepPath,
} from "./pinned-ripgrep.js";

const temporaryRoots: string[] = [];
const runtimeRoot = fileURLToPath(new URL("../../..", import.meta.url));

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("pinned ripgrep resolution", () => {
  it.each([
    ["linux", "x64", "@vscode/ripgrep-linux-x64/bin/rg"],
    ["darwin", "arm64", "@vscode/ripgrep-darwin-arm64/bin/rg"],
    ["win32", "x64", "@vscode/ripgrep-win32-x64/bin/rg.exe"],
  ] as const)(
    "resolves only the exact %s-%s platform package",
    (platform, arch, expectedSpecifier) => {
      const resolvedSpecifiers: string[] = [];
      const expectedPath = resolve("/verified", arch, "rg");
      const actual = resolvePinnedRipgrepPath({
        platform,
        arch,
        resolveModule: (specifier) => {
          resolvedSpecifiers.push(specifier);
          return expectedPath;
        },
      });

      expect(actual).toBe(expectedPath);
      expect(resolvedSpecifiers).toEqual([expectedSpecifier]);
    },
  );

  it("returns unavailable without consulting PATH when package resolution fails", () => {
    const resolvedSpecifiers: string[] = [];
    const result = resolvePinnedRipgrepPath({
      platform: "linux",
      arch: "x64",
      resolveModule: (specifier) => {
        resolvedSpecifiers.push(specifier);
        throw new Error("optional package missing");
      },
    });

    expect(result).toBeUndefined();
    expect(resolvedSpecifiers).toEqual(["@vscode/ripgrep-linux-x64/bin/rg"]);
    expect(
      selectPinnedRipgrepPath({
        available: false,
        path: process.execPath,
      }),
    ).toBeUndefined();
  });

  it("survives module startup in an isolated package without optional platform binaries", async () => {
    // Revert-sensitive: importing @vscode/ripgrep eagerly throws before doctor
    // can report that the optional platform package is absent.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "agenc-pinned-rg-"));
    temporaryRoots.push(fixtureRoot);
    const pinnedRipgrepSource = resolve(
      runtimeRoot,
      "src/tools/system/pinned-ripgrep.ts",
    );
    const bundle = join(fixtureRoot, "pinned-ripgrep.mjs");
    await build({
      bundle: true,
      entryPoints: [pinnedRipgrepSource],
      format: "esm",
      logLevel: "silent",
      outfile: bundle,
      platform: "node",
      target: "node26",
    });
    await writeFile(
      join(fixtureRoot, "probe.mjs"),
      [
        'import { PINNED_RIPGREP_AVAILABLE, PINNED_RIPGREP_PATH } from "./pinned-ripgrep.mjs";',
        "process.stdout.write(JSON.stringify({",
        "  available: PINNED_RIPGREP_AVAILABLE,",
        "  path: PINNED_RIPGREP_PATH ?? null,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    const child = spawnSync(
      process.execPath,
      [join(fixtureRoot, "probe.mjs")],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      },
    );

    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      available: false,
      path: null,
    });
    expect(await readFile(pinnedRipgrepSource, "utf8")).not.toContain(
      'from "@vscode/ripgrep"',
    );
    await expect(access(join(fixtureRoot, "node_modules"))).rejects.toThrow();
  });

  it("resolves a platform binary nested below the packed meta package", async () => {
    const platformPackage = new Map([
      ["darwin-arm64", "@vscode/ripgrep-darwin-arm64"],
      ["darwin-x64", "@vscode/ripgrep-darwin-x64"],
      ["linux-arm64", "@vscode/ripgrep-linux-arm64"],
      ["linux-x64", "@vscode/ripgrep-linux-x64"],
      ["win32-arm64", "@vscode/ripgrep-win32-arm64"],
      ["win32-x64", "@vscode/ripgrep-win32-x64"],
    ]).get(`${process.platform}-${process.arch}`);
    if (platformPackage === undefined) return;

    const fixtureRoot = await mkdtemp(join(tmpdir(), "agenc-nested-rg-"));
    temporaryRoots.push(fixtureRoot);
    const pinnedRipgrepSource = resolve(
      runtimeRoot,
      "src/tools/system/pinned-ripgrep.ts",
    );
    const bundle = join(fixtureRoot, "pinned-ripgrep.mjs");
    await build({
      bundle: true,
      entryPoints: [pinnedRipgrepSource],
      format: "esm",
      logLevel: "silent",
      outfile: bundle,
      platform: "node",
      target: "node26",
    });
    const metaRoot = join(fixtureRoot, "node_modules", "@vscode", "ripgrep");
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    const nestedBinary = join(
      metaRoot,
      "node_modules",
      platformPackage,
      "bin",
      binaryName,
    );
    await mkdir(join(metaRoot, "lib"), { recursive: true });
    await mkdir(join(nestedBinary, ".."), { recursive: true });
    await writeFile(
      join(metaRoot, "package.json"),
      JSON.stringify({ name: "@vscode/ripgrep", main: "lib/index.js" }),
      "utf8",
    );
    await writeFile(
      join(metaRoot, "lib", "index.js"),
      "module.exports = {};\n",
    );
    await writeFile(nestedBinary, "nested pinned ripgrep fixture\n", "utf8");
    await writeFile(
      join(fixtureRoot, "probe.mjs"),
      [
        'import { PINNED_RIPGREP_PATH } from "./pinned-ripgrep.mjs";',
        "process.stdout.write(PINNED_RIPGREP_PATH ?? '');",
      ].join("\n"),
      "utf8",
    );

    const child = spawnSync(
      process.execPath,
      [join(fixtureRoot, "probe.mjs")],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      },
    );

    expect(child.status, child.stderr).toBe(0);
    expect(resolve(child.stdout)).toBe(resolve(nestedBinary));
  });
});
