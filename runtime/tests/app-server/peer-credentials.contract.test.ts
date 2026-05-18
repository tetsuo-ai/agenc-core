import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileAndLoadAgenCNativePeerCredentialBinding,
  loadAgenCNativePeerCredentialBinding,
} from "./transport/peer-credentials.js";

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function tempNodeIncludeDir(): string {
  const includeDir = tempDir("agenc-peer-credentials-include-");
  writeFileSync(path.join(includeDir, "node_api.h"), "");
  return includeDir;
}

function outputPath(args: readonly string[]): string {
  const outputFlagIndex = args.indexOf("-o");
  if (outputFlagIndex === -1 || args[outputFlagIndex + 1] === undefined) {
    throw new Error("missing compiler output path");
  }
  return args[outputFlagIndex + 1];
}

describe("AgenC Unix peer credential native binding", () => {
  it("falls back without compiling when runtime native builds are disabled", () => {
    expect(
      loadAgenCNativePeerCredentialBinding({
        allowRuntimeNativeBuild: false,
        platform: "linux",
      }),
    ).toEqual({
      binding: null,
      error: "runtime native peer credential build disabled",
    });
  });

  it("builds the native addon from a static SO_PEERCRED source", () => {
    const cacheDir = tempDir("agenc-peer-credentials-cache-");
    const includeDir = tempNodeIncludeDir();
    const calls: Array<{ readonly file: string; readonly args: string[] }> = [];
    let sourceText = "";
    const fakeExecFileSync = ((file: string, args: readonly string[]) => {
      const nextArgs = [...args];
      calls.push({ file, args: nextArgs });
      sourceText = readFileSync(nextArgs[nextArgs.length - 1] ?? "", "utf8");
      mkdirSync(path.dirname(outputPath(nextArgs)), { recursive: true });
      writeFileSync(outputPath(nextArgs), "not-a-real-addon");
      return Buffer.alloc(0);
    }) as never;

    try {
      expect(() =>
        compileAndLoadAgenCNativePeerCredentialBinding({
          cacheDir,
          compiler: "cc",
          execFileSync: fakeExecFileSync,
          nodeIncludeDir: includeDir,
          platform: "linux",
        }),
      ).toThrow();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toEqual(
        expect.arrayContaining(["-shared", "-fPIC", "-I", includeDir]),
      );
      expect(sourceText).toContain("SO_PEERCRED");
      expect(sourceText).toContain("getPeerUid");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(includeDir, { recursive: true, force: true });
    }
  });
});
