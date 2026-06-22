import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

describe("runtime manifest dependencies", () => {
  test("declares optional AWS auth modules imported by aws.ts", () => {
    const awsSource = readRepoFile("runtime/src/utils/aws.ts");
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      optionalDependencies?: Record<string, string>;
    };
    const optionalDependencies = runtimePkg.optionalDependencies ?? {};
    const awsAuthModules = [
      "@aws-sdk/client-sts",
      "@aws-sdk/credential-providers",
    ];

    for (const moduleName of awsAuthModules) {
      expect(awsSource).toContain(`'${moduleName}'`);
      expect(optionalDependencies[moduleName]).toMatch(/^\^3\.\d+\.\d+$/);
    }
  });

  test("declares optional Google auth module imported by GCP auth helpers", () => {
    const authSource = readRepoFile("runtime/src/utils/auth.ts");
    const geminiAuthSource = readRepoFile("runtime/src/utils/geminiAuth.ts");
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      optionalDependencies?: Record<string, string>;
    };
    const optionalDependencies = runtimePkg.optionalDependencies ?? {};

    expect(authSource).toContain("'google-auth-library'");
    expect(geminiAuthSource).toContain("'google-auth-library'");
    expect(optionalDependencies["google-auth-library"]).toMatch(
      /^\^10\.\d+\.\d+$/,
    );
  });

  test("declares ZIP archive module imported by plugin zip utilities", () => {
    const zipSource = readRepoFile("runtime/src/utils/dxt/zip.ts");
    const zipCacheSource = readRepoFile(
      "runtime/src/utils/plugins/zipCache.ts",
    );
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = runtimePkg.dependencies ?? {};

    expect(zipSource).toContain("'fflate'");
    expect(zipCacheSource).toContain("'fflate'");
    expect(dependencies.fflate).toMatch(/^\^0\.8\.\d+$/);
  });

  test("does not depend on the CLI-heavy MCPB package for runtime validation", () => {
    const dxtHelperSource = readRepoFile("runtime/src/utils/dxt/helpers.ts");
    const mcpbHandlerSource = readRepoFile(
      "runtime/src/utils/plugins/mcpbHandler.ts",
    );
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(dxtHelperSource).not.toContain("@anthropic-ai/mcpb");
    expect(mcpbHandlerSource).not.toContain("@anthropic-ai/mcpb");
    expect(runtimePkg.dependencies?.["@anthropic-ai/mcpb"]).toBeUndefined();
    expect(
      runtimePkg.optionalDependencies?.["@anthropic-ai/mcpb"],
    ).toBeUndefined();
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

describe("build-time package identity wiring", () => {
  test("MACRO.PACKAGE_URL points at the public launcher package", () => {
    const buildConfig = readRepoFile("runtime/build.config.ts");
    expect(buildConfig).toContain("const publicPackageName = '@tetsuo-ai/agenc'");
    expect(buildConfig).toMatch(
      /'MACRO\.PACKAGE_URL':\s*JSON\.stringify\(publicPackageName\)/,
    );
  });
});

describe("runtime SDK surface hygiene", () => {
  test("does not keep a standalone unexported SDK declaration stub", () => {
    expect(existsSync(`${repoRoot}runtime/src/entrypoints/sdk.d.ts`)).toBe(
      false,
    );
    expect(
      existsSync(`${repoRoot}runtime/src/entrypoints/sdk/controlTypes.ts`),
    ).toBe(false);
  });

  test("root export stays on the daemon embedding surface", () => {
    const indexSource = readRepoFile("runtime/src/index.ts");

    expect(indexSource).toContain("AgenCDaemonJsonRpcDispatcher");
    expect(indexSource).toContain("startAgenCInProcessDaemonTransport");
    expect(indexSource).not.toMatch(
      /\b(query|queryAsync|unstable_v2_createSession|unstable_v2_resumeSession|unstable_v2_prompt|createSdkMcpServer|deleteSession)\b/,
    );
  });

  test("internal SDK barrel remains a type and constants re-export", () => {
    const sdkBarrel = readRepoFile("runtime/src/entrypoints/agentSdkTypes.ts");

    expect(sdkBarrel).toContain(
      "export { EXIT_REASONS, HOOK_EVENTS } from './sdk/coreTypes.js'",
    );
    expect(sdkBarrel).toContain("export type * from './sdk/coreTypes.js'");
    expect(sdkBarrel).not.toMatch(/\bexport\s+(?:async\s+)?function\b/);
    expect(sdkBarrel).not.toContain("throw new Error");
    expect(sdkBarrel).not.toContain("SDKControlRequest");
  });

  test("generated SDK permission update arrays match schemas", () => {
    const schemas = readRepoFile("runtime/src/entrypoints/sdk/coreSchemas.ts");
    const generated = readRepoFile(
      "runtime/src/entrypoints/sdk/coreTypes.generated.ts",
    );

    expect(schemas).toContain(
      "updatedPermissions: z.array(PermissionUpdateSchema()).optional()",
    );
    expect(schemas).toContain(
      "permission_suggestions: z.array(PermissionUpdateSchema()).optional()",
    );
    expect(generated).not.toMatch(
      /(updatedPermissions|permission_suggestions)\?: \(\{/,
    );
    expect(
      generated.match(
        /(updatedPermissions|permission_suggestions)\?: PermissionUpdate\[\]/g,
      ) ?? [],
    ).toHaveLength(6);
  });

  test("generated SDK type workflow uses the checked-in validator", () => {
    const runtimePkg = JSON.parse(readRepoFile("runtime/package.json")) as {
      scripts?: Record<string, string>;
    };
    const workflowFiles = [
      "runtime/src/entrypoints/sdk/coreSchemas.ts",
      "runtime/src/entrypoints/sdk/coreTypes.ts",
      "runtime/src/entrypoints/sdk/coreTypes.generated.ts",
    ];
    const checkCommand =
      "npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types";

    expect(runtimePkg.scripts?.["check:sdk-generated-types"]).toBe(
      "node scripts/check-sdk-generated-types.mjs",
    );
    expect(
      existsSync(`${repoRoot}runtime/scripts/check-sdk-generated-types.mjs`),
    ).toBe(true);

    for (const relativePath of workflowFiles) {
      const source = readRepoFile(relativePath);
      expect(source).not.toContain("generate-sdk-types.ts");
      expect(source).toContain(checkCommand);
    }

    execFileSync(
      process.execPath,
      ["runtime/scripts/check-sdk-generated-types.mjs"],
      { cwd: repoRoot, stdio: "pipe" },
    );
  });
});
