import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import {
  PINNED_RIPGREP_PATH,
  resolvePinnedRipgrepPath,
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
    expect(isAbsolute(PINNED_RIPGREP_PATH)).toBe(true);
    expect(PINNED_RIPGREP_PATH).not.toBe("rg");
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
        'import { existsSync } from "node:fs";',
        'import { isAbsolute } from "node:path";',
        'import { PINNED_RIPGREP_AVAILABLE, PINNED_RIPGREP_PATH } from "./pinned-ripgrep.mjs";',
        "process.stdout.write(JSON.stringify({",
        "  available: PINNED_RIPGREP_AVAILABLE,",
        "  absolute: isAbsolute(PINNED_RIPGREP_PATH),",
        "  exists: existsSync(PINNED_RIPGREP_PATH),",
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
      absolute: true,
      exists: false,
    });
    expect(await readFile(pinnedRipgrepSource, "utf8")).not.toContain(
      'from "@vscode/ripgrep"',
    );
    expect(existsSync(join(fixtureRoot, "node_modules"))).toBe(false);
  });
});
