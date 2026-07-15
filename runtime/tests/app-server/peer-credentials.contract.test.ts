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

  const itNonRoot =
    typeof process.getuid === "function" && process.getuid() !== 0 ? it : it.skip;

  itNonRoot("rejects a current-user addon when system policy requires root ownership", () => {
    const dir = tempDir("agenc-peer-credentials-root-policy-");
    const addonPath = path.join(dir, "agenc-peer-credentials.node");
    writeFileSync(addonPath, "not-a-real-addon", { mode: 0o600 });
    try {
      expect(
        loadAgenCNativePeerCredentialBinding({
          nativeAddonPath: addonPath,
          platform: "linux",
          requireRootOwnedNativeAddon: true,
        }),
      ).toEqual({
        binding: null,
        error: expect.stringContaining("not root-owned"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        expect.arrayContaining([
          "-O2",
          "-D_FORTIFY_SOURCE=2",
          "-fstack-protector-strong",
          "-shared",
          "-fPIC",
          "-Werror",
          "-I",
          includeDir,
          "-Wl,-z,relro,-z,now,-z,noexecstack,--build-id=none",
        ]),
      );
      expect(sourceText).toContain("SO_PEERCRED");
      expect(sourceText).toContain("getPeerUid");
      expect(sourceText).toContain("length != sizeof(credentials)");
      expect(sourceText).toContain("napi_define_properties(env, exports, 1, descriptors) != napi_ok");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(includeDir, { recursive: true, force: true });
    }
  });
});
