import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");
const HOSTED_TEST_COMMANDS = [
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run validate:runtime",
  "npm run check:required-gates",
  "npm run check:agent-surface-contract",
  "npm run check:sbom",
  "check:tui-runtime-startup",
  "vitest",
  "tsc --noEmit",
] as const;

function expectArtifactWorkflowWithoutHostedTests(workflow: string) {
  for (const command of HOSTED_TEST_COMMANDS) expect(workflow).not.toContain(command);
}

describe("reproducible install and release contract", () => {
  test("standalone installers are generated from the canonical lock modules", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [join(REPO_ROOT, "scripts/sync-installer-sqlite-lock.mjs"), "--check"],
        { encoding: "utf8" },
      )).not.toThrow();
    for (const relativePath of [
      "scripts/install/install.sh",
      "scripts/install/install.ps1",
    ]) {
      const installer = readFileSync(join(REPO_ROOT, relativePath), "utf8");
      expect(installer).toContain("await acquireLocalSqliteLock(");
      expect(installer).toContain("await acquireLocalSqliteLocks(");
      expect(installer).not.toContain("function acquireLocks(requestedPaths");
      expect(installer).not.toContain("PRAGMA busy_timeout = ${Math.min");
      expect(installer).toContain("loadActivationLockIdentityModule()");
      expect(installer).toContain("resolveActivationLockRegistry()");
      expect(installer).not.toContain("function windowsAccountLockRegistry");
      expect(installer).not.toContain("function activationLockRegistry");
      expect(installer).not.toContain('toLocaleLowerCase("en-US")');
    }
  });

  test("committed root lock matches the complete workspace set", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license: string;
      packageManager: string;
      workspaces: string[];
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8")) as {
      version: string;
      lockfileVersion: number;
      packages: Record<string, {
        name?: string;
        version?: string;
        license?: string;
        workspaces?: string[];
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>;
    };
    expect(root.packageManager).toBe("npm@11.17.0");
    expect(root.workspaces).toEqual(["packages/agenc", "packages/agenc-sdk", "runtime"]);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.version).toBe(root.version);
    expect(lock.packages[""]?.workspaces).toEqual(root.workspaces);
    expect(root.dependencies).toBeUndefined();
    expect(lock.packages[""]?.dependencies).toBeUndefined();
    for (const field of ["name", "version", "license", "workspaces", "devDependencies"] as const) {
      expect(lock.packages[""]?.[field], `root lock snapshot ${field}`).toEqual(root[field]);
    }
    for (const workspace of root.workspaces) {
      expect(existsSync(join(REPO_ROOT, workspace, "package.json"))).toBe(true);
      expect(lock.packages[workspace]).toBeDefined();
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, workspace, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const snapshot = lock.packages[workspace] as Record<string, unknown>;
      for (const field of [
        "name",
        "version",
        "license",
        "bin",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "engines",
      ]) {
        expect(snapshot[field], `${workspace} lock snapshot ${field}`).toEqual(
          manifest[field],
        );
      }
    }
    expect(readFileSync(join(REPO_ROOT, ".npmrc"), "utf8")).toBe(
      "install-strategy=hoisted\nstrict-allow-scripts=true\n",
    );
  });

  test("release-sensitive text inputs check out with canonical LF endings", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      workspaces: string[];
    };
    const binSubjects = root.workspaces.flatMap((workspace) => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, workspace, "package.json"), "utf8"),
      ) as { bin?: string | Record<string, string> };
      const targets = typeof manifest.bin === "string"
        ? [manifest.bin]
        : Object.values(manifest.bin ?? {});
      return targets.map((target) => join(workspace, target).replaceAll("\\", "/"));
    });
    const lfSubjects = [...binSubjects, "package-lock.json"];
    const attributes = execFileSync(
      "git",
      ["check-attr", "eol", "--", ...lfSubjects],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    for (const subject of lfSubjects) {
      expect(attributes).toContain(`${subject}: eol: lf`);
    }
  });

  test("the active release workflow uses pinned inputs and proves two native builds match", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/release-runtime.yml"),
      "utf8",
    );
    expect(
      workflow.match(/"\$AGENC_NODE_EXECUTABLE_PATH" "\$AGENC_NPM_CLI_PATH" ci --prefix/g),
    ).toHaveLength(2);
    expect(
      workflow.match(/"\$build_source\/packages\/agenc\/scripts\/build-runtime-tarball\.mjs"/g),
    ).toHaveLength(2);
    expect(workflow).not.toContain('require(\\"./runtime/package.json');
    expect(workflow).not.toMatch(/run:\s+npm install(?! --global)/);
    expect(workflow).toContain('NODE_VERSION: "25.9.0"');
    expect(workflow).toContain('NPM_VERSION: "11.17.0"');
    expect(workflow).toContain("libatomic-8.5.0-28.el8_10");
    expect(workflow).toContain("gcc-toolset-12-gcc-c++-12.2.1-7.8.el8_10");
    expect(workflow).toContain("python3.12-3.12.13-2.el8_10");
    expect(workflow).toContain('["rpmContentInventory"]');
    expect(workflow).toContain("%{SHA256HEADER}");
    expect(workflow).toContain("%{PAYLOADDIGEST}");
    expect(workflow).toContain("%{RSAHEADER:pgpsig}");
    expect(workflow).toContain("signed RPM content inventory drift");
    expect(workflow).toContain("rpm-content-sha256:");
    expect(workflow).toContain("verify-reproducible-artifacts.mjs");
    expect(workflow).toContain("AGENC_BUILDER_ID=");
    expect(workflow).toContain("AGENC_NODE_DISTRIBUTION_SHA256=");
    expect(workflow).toContain("AGENC_NODE_HEADERS_SHA256=");
    expect(workflow).toContain("AGENC_NODE_COMMON_GYPI_SHA256=");
    expect(workflow).toContain("AGENC_NPM_DISTRIBUTION_SHA256=");
    expect(workflow).toContain("AGENC_NODE_EXECUTABLE_PATH=");
    expect(workflow).toContain("AGENC_NPM_CLI_PATH=");
    expect(workflow).toContain("npm_config_nodedir=");
    expect(workflow).toContain("nodeDistributions");
    expect(workflow).toContain("nodeHeaders");
    expect(workflow).toContain("Get-FileHash -Algorithm SHA256");
    expect(workflow).toContain("AGENC_NODE_IMPORT_LIBRARY_SHA256=");
    expect(workflow).toContain("AGENC_NODE_IMPORT_LIBRARY_BYTES=");
    expect(workflow).toContain("Invoke-WebRequest -Uri $importLibrary.url");
    expect(workflow).toContain("Validate the reviewed macOS runner and native toolchain");
    expect(workflow).toContain("Validate and activate the reviewed Windows runner and native toolchain");
    expect(workflow).toContain("hostedRunners");
    expect(workflow).toContain("Assert-Exact 'ImageVersion'");
    expect(workflow).toContain("Assert-Exact 'active MSVC tools version'");
    expect(workflow).toContain("MSVC compiler identity");
    const linuxInstall = workflow.slice(
      workflow.indexOf("Install digest-pinned Node, headers, and npm"),
      workflow.indexOf("Build from two isolated worktrees and compare bytes"),
    );
    expect(linuxInstall).toContain("rpm -q --qf '%{NAME}-%{VERSION}-%{RELEASE}' libatomic");
    expect(linuxInstall).toContain('ldd "$node_root/bin/node"');
    expect(linuxInstall).toContain("portable Node has unresolved shared libraries");
    expect(linuxInstall.indexOf('ldd "$node_root/bin/node"')).toBeLessThan(
      linuxInstall.indexOf('"$node_root/bin/node" "$node_root/lib/node_modules/npm/bin/npm-cli.js"'),
    );
    const linuxBuild = workflow.slice(
      workflow.indexOf("Build from two isolated worktrees and compare bytes"),
      workflow.indexOf("Select the canonical runtime subject and bundle path"),
    );
    expect(linuxBuild).toContain('git config --global --add safe.directory "$source_root"');
    expect(linuxBuild).not.toContain("safe.directory '*'");
    expect(linuxBuild.indexOf("safe.directory")).toBeLessThan(
      linuxBuild.indexOf("git worktree add"),
    );
    const nativeJob = workflow.slice(workflow.indexOf("\n  native-tarball:"));
    const macosValidation = nativeJob.slice(
      nativeJob.indexOf("Validate the reviewed macOS runner"),
      nativeJob.indexOf("Validate and activate the reviewed Windows runner"),
    );
    expect(macosValidation).toContain('capture("xcrun", "--sdk", "macosx", "--show-sdk-path")');
    expect(macosValidation).toContain('functional = os.path.join(sdk_path, "usr", "include", "c++", "v1", "functional")');
    expect(macosValidation).toContain('probe_environment["SDKROOT"] = sdk_path');
    expect(macosValidation).toContain('environment.write(f\'SDKROOT={sdk_path}\\n\')');
    const windowsValidation = nativeJob.slice(
      nativeJob.indexOf("Validate and activate the reviewed Windows runner"),
      nativeJob.indexOf("Install digest-pinned Node, headers, and npm (macOS)"),
    );
    expect(windowsValidation).toMatch(
      /\$compilerLines = @\(& \$cl \/Bv[\s\S]*?\$global:LASTEXITCODE = 0[\s\S]*?MSVC compiler identity/,
    );
    expect(windowsValidation).toContain("if ($name -ieq 'PATH') { $name = 'PATH' }");
    const windowsInstall = nativeJob.slice(
      nativeJob.indexOf("Install digest-pinned Node, headers, and npm (Windows)"),
      nativeJob.indexOf("Build from two isolated worktrees and compare bytes"),
    );
    expect(windowsInstall).toContain("$headersRelease = Join-Path $headersRoot 'Release'");
    expect(windowsInstall).toContain(
      "Copy-Item -LiteralPath $nodeImportLibrary -Destination $headersNodeImportLibrary",
    );
    expect(windowsInstall).toContain(
      "Assert-Sha256 $headersNodeImportLibrary $importLibrary.sha256",
    );
    expect(windowsInstall).toContain(
      "Assert-Bytes $headersNodeImportLibrary $importLibrary.bytes",
    );
    expect(windowsInstall).toContain(
      "packages/agenc/scripts/prepare-windows-node-headers.mjs --root $headersRoot",
    );
    expect(windowsInstall).toContain(
      "$headerProof.sha256 -cne $toolchain.nodeHeaders.windowsCommonGypi.releaseSha256",
    );
    expect(windowsInstall).toContain(
      '"AGENC_NODE_COMMON_GYPI_SHA256=$($headerProof.sha256)"',
    );
    expect(windowsInstall).toContain(
      "& $nodeExecutablePath $npmCliPath install --global $npmArchive --prefix $nodeRoot",
    );
    expect(windowsInstall.indexOf("prepare-windows-node-headers.mjs")).toBeLessThan(
      windowsInstall.indexOf('"AGENC_NODE_COMMON_GYPI_SHA256=$($headerProof.sha256)"'),
    );
    expect(nativeJob.indexOf("Validate the reviewed macOS runner")).toBeLessThan(
      nativeJob.indexOf('"$AGENC_NODE_EXECUTABLE_PATH" "$AGENC_NPM_CLI_PATH" ci --prefix'),
    );
    expect(nativeJob.indexOf("Validate and activate the reviewed Windows runner")).toBeLessThan(
      nativeJob.indexOf('"$AGENC_NODE_EXECUTABLE_PATH" "$AGENC_NPM_CLI_PATH" ci --prefix'),
    );
    expect(workflow.match(/artifact-metadata: write/g)).toHaveLength(2);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n\nenv:/m);
    expect(workflow.match(/subject-path: \|\n\s+\$\{\{ steps\.runtime-artifact\.outputs\.path \}\}\n\s+\$\{\{ steps\.runtime-artifact\.outputs\.metadata \}\}/g)).toHaveLength(2);
    expect(workflow.match(/steps\.attest-runtime\.outputs\.bundle-path/g)).toHaveLength(2);
    expect(workflow.match(/agenc-runtime-\*\.tar\.gz\.sigstore\.json/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/with:\n\s+subject-path:[^\n]+\n\s+bundle-path:/);
    expect(workflow).toContain("actions/attest bundle is not one regular file");
    expect(workflow.match(/source_metadata\.st_size > 4 \* 1024 \* 1024/g)).toHaveLength(2);
    expect(workflow.match(/actions\/attest bundle is outside the 4 MiB release bound/g)).toHaveLength(2);
    expect(workflow.match(/or destination\.is_symlink\(\)/g)).toHaveLength(2);
    expect(workflow).not.toContain("actions/setup-node");
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(4);
    expect(workflow.match(/git -C .* worktree remove --force/g)).toHaveLength(4);
    expect(workflow).toContain("Upload failed reproducibility inputs");
    expect(workflow).toContain("if-no-files-found: ignore");
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).toContain("agenc-repro-diagnostics-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
    expect(workflow).toContain('npm-cache-$build');
    expect(workflow).not.toMatch(/uses:\s+actions\/[\w-]+@v\d/);
    expect(workflow).not.toContain("cache: npm");
    const inactive = readFileSync(
      join(REPO_ROOT, "packages/agenc/release/release.workflow.yml"),
      "utf8",
    );
    expect(inactive).toContain("INACTIVE SAFETY STUB");
    expect(inactive).toContain("jobs: {}");
    expect(inactive).not.toContain("npm publish");
    const builder = readFileSync(
      join(REPO_ROOT, "packages/agenc/scripts/build-runtime-tarball.mjs"),
      "utf8",
    );
    expect(builder).toContain('"MACOSX_DEPLOYMENT_TARGET", "SDKROOT"');
    expect(builder).toContain('"-Wl,-S"');
    expect(builder).not.toContain('"-Wl,-no_uuid"');
    expect(builder).not.toContain('"-Wl,-oso_prefix,."');
    expect(builder).toContain('"/PDBALTPATH:%_PDB%"');
    expect(builder).toContain('append("_LINK_", ["/DEBUG:NONE", "/INCREMENTAL:NO", "/Brepro"])');
    expect(builder).toContain("`/d1trimfile:${buildRoot}\\\\`");
    expect(builder).toContain('WINDOWS_NATIVE_BUILD_ROOT_PROVENANCE = "<release-stage>"');
    expect(builder).toContain('"CL", "LINK", "_LINK_"');
    expect(builder).toContain("? canonicalWindowsNativeBuildRoot(stage)");
    expect(builder).toContain(
      "releaseEnv = withWindowsReproducibleNativeFlags(releaseEnv, nativeBuildRoot)",
    );
    expect(builder).toContain(
      "windowsReproducibleNativeFlagProvenance(releaseEnv, nativeBuildRoot)",
    );
    expect(builder).not.toContain("Object.assign(releaseEnv, withWindowsReproducibleNativeFlags");
    expect(builder).toContain("release builds require verified AGENC_NODE_EXECUTABLE_PATH and AGENC_NPM_CLI_PATH");
    expect(builder).toContain("release-toolchain.json has no valid Windows common.gypi contract");
    expect(builder).toContain("AGENC_NODE_COMMON_GYPI_SHA256");
    expect(builder).toContain("metadata.nodeCommonGypiSourceSha256");
    expect(builder).toContain("metadata.nodeCommonGypiReleaseSha256");
    expect(builder).toContain("metadata.nodeCommonGypiTransformation");
    expect(builder).toContain("runNpm(buildExecutables");
    expect(builder).toContain("captureNpm(buildExecutables");
    expect(builder).toContain("release build process is not running under the verified Node executable");
    expect(builder).not.toContain("shell: IS_WINDOWS");
    expect(builder).toContain('"ci"');
    expect(builder).toContain('"--workspace=@tetsuo-ai/runtime"');
    expect(builder).toContain("writeCanonicalArchive");
    expect(builder).toContain("release Linux signed RPM content inventory does not match");
    expect(builder).toContain("assertHostedRunnerContract");
    expect(builder).toContain("metadata.nodeImportLibraryFile = expectedImportLibrary.file");
    expect(builder).toContain("metadata.nodeImportLibraryBytes = importLibraryBytes");
    expect(builder).not.toMatch(/\[\s*"install",\s*runtimeTgz/);
    const nativeContract = JSON.parse(
      readFileSync(join(REPO_ROOT, "release-toolchain.json"), "utf8"),
    ) as {
      hostedRunners: Record<string, Record<string, string>>;
      nodeHeaders: {
        windowsCommonGypi: {
          schemaVersion: number;
          path: string;
          sourceSha256: string;
          releaseSha256: string;
          transformation: string;
        };
      };
      nodeImportLibraries: Record<
        string,
        { file: string; url: string; sha256: string; bytes: number }
      >;
      linux: {
        builderPackages: Record<string, string>;
        rpmContentInventory: {
          schemaVersion: number;
          signatureKeyIds: string[];
          sha256: Record<string, string>;
        };
      };
    };
    expect(nativeContract.hostedRunners).toMatchObject({
      "darwin-arm64": {
        runnerLabel: "macos-15",
        imageOS: "macos15",
        imageVersion: "20260715.0234.1",
        runnerArch: "ARM64",
        xcodeVersion: "16.4",
        xcodeBuild: "16F6",
        macosSdkVersion: "15.5",
        clangVersion: "Apple clang version 17.0.0 (clang-1700.0.13.5)",
      },
      "darwin-x64": {
        runnerLabel: "macos-15-intel",
        imageVersion: "20260715.0340.1",
        runnerArch: "X64",
      },
      "win-x64": {
        runnerLabel: "windows-2025",
        imageOS: "win25-vs2026",
        imageVersion: "20260714.173.1",
        runnerArch: "X64",
        visualStudioVersion: "18.7.11925.98",
        msvcToolsVersion: "14.51.36231",
        windowsSdkVersion: "10.0.26100.0",
      },
    });
    expect(nativeContract.linux.builderPackages.libatomic).toBe(
      "libatomic-8.5.0-28.el8_10",
    );
    expect(nativeContract.nodeImportLibraries["win-x64"]).toEqual({
      file: "node.lib",
      url: "https://nodejs.org/dist/v25.9.0/win-x64/node.lib",
      sha256: "e3577a5a4a772b21646fe05a24d53ce3727395bbbc412f326889ddf7129bc7a9",
      bytes: 2_995_712,
    });
    expect(nativeContract.nodeHeaders.windowsCommonGypi).toEqual({
      schemaVersion: 1,
      path: "include/node/common.gypi",
      sourceSha256: "1fa5e02d19706d796b1ba275f11e3a2deec59d34eaaf34efab5779145f385f8a",
      releaseSha256: "8a9331b700e6cdd52e611d249a78e02513d70dd45f4be314bf6f1e301d4bbd2d",
      transformation: "disable-debug-information-and-full-paths",
    });
    expect(nativeContract.linux.rpmContentInventory).toEqual({
      schemaVersion: 1,
      format:
        "name|epoch|version|release|arch|sha256header|payloaddigest|payloaddigestalgo|rsaheader-pgpsig",
      signatureKeyIds: ["15af5dac6d745a60"],
      sha256: {
        x64: "b218a774252c748c748d0e18837b7ca655c8e657bc20b1213a9f8cbb177b58bb",
        arm64: "cd2f3fb1aa51e2142ca74e202d9403b2861d47fc82cb036150ecb92ee62306d2",
      },
    });
  });

  test("npm trusted publishing transfers and publishes only attested reviewed bytes", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/publish-npm.yml"),
      "utf8",
    );
    expect(workflow).toContain("environment: npm-production");
    expect(workflow).toContain('NODE_VERSION: "25.9.0"');
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    const releaseSourceJob = workflow.slice(
      workflow.indexOf("\n  release-source:"),
      workflow.indexOf("\n  pack:"),
    );
    const packJob = workflow.slice(
      workflow.indexOf("\n  pack:"),
      workflow.indexOf("\n  publish:"),
    );
    const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
    expect(packJob).not.toContain("id-token: write");
    expect(packJob).not.toContain("actions/attest@");
    expect(workflow).toContain('test "$GITHUB_REF_TYPE" = tag');
    expect(workflow).toContain('expected_ref="refs/tags/agenc-v${version}"');
    expect(workflow).toContain('test "$REPOSITORY_VISIBILITY" = public');
    expect(releaseSourceJob).not.toContain("checks: read");
    expect(releaseSourceJob).not.toContain("AGENC_LOCAL_GATE_APP_ID");
    expect(releaseSourceJob).not.toContain("scripts/verify-required-gate-check.mjs");
    expect(releaseSourceJob).toContain("LOCAL_EVIDENCE_SHA256");
    expect(releaseSourceJob).toContain('test "$TESTED_SHA" = "$GITHUB_SHA"');
    expect(releaseSourceJob).toContain(
      'test "$(git rev-parse --verify "${expected_ref}^{commit}")" = "$GITHUB_SHA"',
    );
    expect(workflow).not.toContain("required-gates:");
    expectArtifactWorkflowWithoutHostedTests(workflow);
    for (const job of [releaseSourceJob, packJob, publishJob]) {
      expect(job.match(/git merge-base --is-ancestor/g)).toHaveLength(1);
      expect(job.match(/persist-credentials: false/g)).toHaveLength(1);
    }
    expect(workflow).toContain("gh release verify \"$RELEASE_TAG\"");
    expect(workflow).toContain("gh release verify-asset");
    const releaseInventory = readFileSync(
      join(REPO_ROOT, "scripts/validate-runtime-release-inventory.py"),
      "utf8",
    );
    expect(releaseInventory).toContain('release.get("immutable") is not True');
    expect(workflow).toContain("prepare-release-assets.mjs");
    expect(workflow.match(/validate-runtime-release-inventory\.py/g)).toHaveLength(2);
    expect(workflow).toContain('--prepared-root "$owned_root/verified-release"');
    expect(workflow).toContain("agenc-runtime-manifest-v2.json");
    expect(workflow).toContain("--legacy-manifest");
    expect(workflow).not.toContain("npm test --workspace=@tetsuo-ai/agenc");
    expect(workflow).toContain("git worktree add --detach");
    expect(workflow).toMatch(/\(\n\s+cd \"\$source\"[\s\S]+node scripts\/npm-release\.mjs pack/);
    expect(workflow).toContain("--workspace=@tetsuo-ai/agenc");
    expect(workflow).toContain("*.tgz.release.json");
    expect(workflow).toContain("gh attestation verify \"$asset\"");
    expect(workflow).toContain("artifact-ids: ${{ needs.pack.outputs.artifact-id }}");
    expect(workflow).toContain("githubCli");
    const toolchain = JSON.parse(
      readFileSync(join(REPO_ROOT, "release-toolchain.json"), "utf8"),
    ) as {
      githubCli: {
        version: string;
        linuxX64: { file: string; sha256: string; bytes: number };
        linuxArm64: { file: string; sha256: string; bytes: number };
        macosX64: { file: string; sha256: string; bytes: number };
        macosArm64: { file: string; sha256: string; bytes: number };
        windowsX64: { file: string; sha256: string; bytes: number };
      };
    };
    expect(toolchain.githubCli.version).toBe("2.96.0");
    expect(toolchain.githubCli.linuxX64.file).toBe("gh_2.96.0_linux_amd64.tar.gz");
    expect(toolchain.githubCli.linuxX64.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.entries(toolchain.githubCli).filter(([key]) => key !== "version")).toEqual(
      expect.arrayContaining([
        ["linuxX64", expect.objectContaining({ bytes: 14652560 })],
        ["linuxArm64", expect.objectContaining({ bytes: 13321232 })],
        ["macosX64", expect.objectContaining({ bytes: 15298430 })],
        ["macosArm64", expect.objectContaining({ bytes: 13950131 })],
        ["windowsX64", expect.objectContaining({ bytes: 14821821 })],
      ]),
    );
    for (const pin of Object.values(toolchain.githubCli).filter(
      (value): value is { file: string; sha256: string; bytes: number } =>
        typeof value !== "string",
    )) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.bytes).toBeGreaterThan(0);
    }
    expect(workflow).toContain('node scripts/npm-release.mjs verify "$tarball"');
    expect(workflow).toContain(
      'node scripts/npm-release.mjs publish "$tarball" --tag=latest',
    );
    expect(workflow).toContain('NODE_AUTH_TOKEN: ""');
    expect(workflow).toContain('NPM_TOKEN: ""');
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("actions/setup-node");
    expect(workflow).not.toMatch(/uses:\s+actions\/[\w-]+@v\d/);
    expect(workflow).not.toMatch(/run:\s+npm publish/);
    expect(workflow).toContain("npm ci --prefix \"$source\"");
    expect(workflow).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(workflow.indexOf("environment: npm-production")).toBeLessThan(
      workflow.indexOf("actions/attest@"),
    );
    expect(workflow.indexOf("npm-release.mjs verify")).toBeLessThan(
      workflow.indexOf("actions/attest@"),
    );
    expect(workflow.indexOf("actions/attest@")).toBeLessThan(
      workflow.indexOf("npm-release.mjs publish"),
    );
  });

  test("runtime artifact jobs bind to the exact release tag without running tests", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/release-runtime.yml"),
      "utf8",
    );
    const releaseSourceJob = workflow.slice(
      workflow.indexOf("\n  release-source:"),
      workflow.indexOf("\n  linux-tarball:"),
    );
    expect(releaseSourceJob).not.toContain("checks: read");
    expect(releaseSourceJob).not.toContain("AGENC_LOCAL_GATE_APP_ID");
    expect(releaseSourceJob).not.toContain("scripts/verify-required-gate-check.mjs");
    expect(releaseSourceJob).toContain("LOCAL_EVIDENCE_SHA256");
    expect(releaseSourceJob).toContain('test "$TESTED_SHA" = "$GITHUB_SHA"');
    expect(releaseSourceJob).toContain(
      'test "$(git rev-parse --verify "${expected_ref}^{commit}")" = "$GITHUB_SHA"',
    );
    expect(workflow).not.toContain("required-gates:");
    expectArtifactWorkflowWithoutHostedTests(workflow);
    expect(workflow).toMatch(/\n  linux-tarball:\n    needs: release-source\n/u);
    expect(workflow).toMatch(/\n  native-tarball:\n    needs: release-source\n/u);
  });

  test("the ESM bundle disables redundant per-module strict directives", () => {
    const buildScript = readFileSync(
      join(REPO_ROOT, "runtime/scripts/build-runtime.mjs"),
      "utf8",
    );
    const bundleTsconfig = readFileSync(
      join(REPO_ROOT, "runtime/tsconfig.bundle.json"),
      "utf8",
    );
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")).toContain(
      "!/runtime/tsconfig.bundle.json",
    );
    expect(buildScript).toContain('resolve(runtimeRoot, "tsconfig.bundle.json")');
    expect(buildScript).toContain("tsconfig: bundleTsconfigPath");
    expect(bundleTsconfig).toContain('"strict": false');
    expect(bundleTsconfig).toContain('"alwaysStrict": false');
  });

  test("clean-build plan covers two installs, packages, declarations, SBOM, and Docker", () => {
    const output = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/check-clean-build.mjs"), "--plan"],
      { encoding: "utf8" },
    );
    const plan = JSON.parse(output) as {
      cleanInstalls: number;
      secondInstall: string;
      compared: string[];
      docker: string;
    };
    expect(plan.cleanInstalls).toBe(2);
    expect(plan.secondInstall).toContain("offline");
    expect(plan.compared).toEqual(
      expect.arrayContaining([
        expect.stringContaining("runtime dist and declarations"),
        expect.stringContaining("SDK dist and declarations"),
        expect.stringContaining("launcher"),
        expect.stringContaining("SBOM"),
      ]),
    );
    expect(plan.docker).toContain("two pristine-context");
    expect(plan.docker).toContain("byte-identical recursive OCI layouts");
    const help = execFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts/check-clean-build.mjs"), "--help"],
      { encoding: "utf8" },
    );
    expect(help).toContain("--buildkit-network=host");
    expect(help).toContain("retains full Docker acceptance");
    const dockerfile = readFileSync(
      join(REPO_ROOT, "packaging/docker/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("WORKDIR /opt/agenc-release-source");
    expect(dockerfile).not.toContain("WORKDIR /src");
  });

  test("Docker resolves only digest and snapshot-pinned build inputs", () => {
    const toolchain = JSON.parse(
      readFileSync(join(REPO_ROOT, "release-toolchain.json"), "utf8"),
    ) as {
      nodeVersion: string;
      nodeMajor: number;
      nodeModuleAbi: string;
      nodeApiVersion: string;
      docker: {
        dockerfileFrontend: string;
        buildx: {
          version: string;
          "linux-amd64": { file: string; url: string; sha256: string };
          "linux-arm64": { file: string; url: string; sha256: string };
        };
        buildkit: {
          version: string;
          image: string;
          compatibilityVersion: string;
        };
        buildImage: string;
        runtimeImage: string;
        debianSnapshot: {
          timestamp: string;
          repositories: Array<{
            archive: string;
            suite: string;
            components: string[];
          }>;
        };
        runtimePackages: Record<string, string>;
      };
    };
    const dockerfile = readFileSync(
      join(REPO_ROOT, "packaging/docker/Dockerfile"),
      "utf8",
    );
    expect(toolchain).toMatchObject({
      nodeVersion: "25.9.0",
      nodeMajor: 25,
      nodeModuleAbi: "141",
      nodeApiVersion: "10",
    });
    const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
    expect(dockerfile.split("\n", 1)[0]).toBe(`# syntax=${toolchain.docker.dockerfileFrontend}`);
    expect(toolchain.docker.buildx.version).toBe("0.35.0");
    for (const arch of ["linux-amd64", "linux-arm64"] as const) {
      expect(toolchain.docker.buildx[arch].file).toBe(`buildx-v0.35.0.${arch}`);
      expect(toolchain.docker.buildx[arch].url).toContain("/docker/buildx/releases/download/v0.35.0/");
      expect(toolchain.docker.buildx[arch].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(toolchain.docker.buildkit).toEqual({
      version: "0.31.1",
      image:
        "moby/buildkit:v0.31.1@sha256:6b59b7df63a8cb9902736f9ddf7fcff8261613d3e7449b8ea8b7537fc399c03a",
      compatibilityVersion: "30",
    });
    expect(images).toEqual([toolchain.docker.buildImage, toolchain.docker.runtimeImage]);
    expect(toolchain.docker.debianSnapshot.timestamp).toMatch(/^[0-9]{8}T[0-9]{6}Z$/);
    expect(toolchain.docker.debianSnapshot.repositories).toEqual([
      { archive: "debian", suite: "bookworm", components: ["main"] },
      { archive: "debian", suite: "bookworm-updates", components: ["main"] },
      { archive: "debian-security", suite: "bookworm-security", components: ["main"] },
    ]);
    expect(toolchain.docker.runtimePackages).toEqual({
      ripgrep: "13.0.0-4+b2",
      git: "1:2.39.5-0+deb12u3",
      "ca-certificates": "20230311+deb12u1",
      tini: "0.19.0-1+b3",
    });
    expect(dockerfile).toContain("https://snapshot.debian.org/archive/${archive}/${timestamp}/");
    expect(dockerfile).toContain('.join("\\n")');
    expect(dockerfile).not.toContain('.join("\\\\n")');
    expect(dockerfile).toContain("Acquire::Check-Valid-Until=false");
    expect(dockerfile).toContain("signed-by=/usr/share/keyrings/debian-archive-keyring.gpg");
    expect(dockerfile).toContain("update --error-on=any");
    expect(dockerfile.match(/npm_config_nodedir=\/usr\/local/g)).toHaveLength(2);
    expect(dockerfile).toContain("/usr/share/agenc/debian-packages.txt");
    expect(dockerfile).toContain("/var/cache/ldconfig/aux-cache");
    expect(dockerfile).toContain("/var/log/alternatives.log");
    expect(dockerfile).toContain("XDG_CACHE_HOME=/data/.cache");
    expect(dockerfile).toContain("/usr/lib/agenc/peer-credentials-required");
    expect(dockerfile).not.toContain("ENV AGENC_NATIVE_PEER_CREDENTIAL_ADDON");
    expect(dockerfile).toContain("/opt/agenc-native/agenc-peer-credentials.node");
    expect(dockerfile).not.toContain("ln -sf /usr/bin/gcc");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).not.toContain("chown -R agenc:agenc /opt/agenc");
    expect(dockerfile).toContain('CMD ["agenc", "daemon", "status"]');
    expect(dockerfile).not.toMatch(/^RUN apt-get update/m);

    const compose = readFileSync(
      join(REPO_ROOT, "packaging/docker/docker-compose.yml"),
      "utf8",
    );
    for (const name of [
      "AGENC_BUILD_COMMIT",
      "SOURCE_DATE_EPOCH",
      "AGENC_BUILD_TIME",
      "AGENC_VERSION",
    ]) {
      expect(compose).toContain(`${name}: \${${name}:?`);
    }
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("cap_drop:");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain(
      "context: ${AGENC_DOCKER_CONTEXT:?set AGENC_DOCKER_CONTEXT",
    );
    expect(compose).not.toContain("context: ../..");
    const installDocs = readFileSync(join(REPO_ROOT, "docs/install.md"), "utf8");
    expect(installDocs).toContain("git archive --format=tar HEAD");
    expect(installDocs).toContain("Docker publication is intentionally disabled");
    expect(installDocs).toContain("npm run release:preflight");
    expect(installDocs).not.toContain("! npm view");
    expect(installDocs).not.toContain("! gh release view");
    expect(installDocs).toContain("--workspace=@tetsuo-ai/agenc");
    expect(installDocs).toContain("--github-cli \"$github_cli\"");
    expect(installDocs).not.toContain("-t ghcr.io/tetsuo-ai/agenc:latest");
    const cleanBuild = readFileSync(
      join(REPO_ROOT, "scripts/check-clean-build.mjs"),
      "utf8",
    );
    expect(cleanBuild).toContain("Docker OCI layout is not byte-reproducible");
    expect(cleanBuild).toContain('["buildx", "version"]');
    expect(cleanBuild).toContain('"--provenance=false"');
    expect(cleanBuild).toContain("rewrite-timestamp=true");
    expect(cleanBuild).toContain("BUILDKIT_MULTI_PLATFORM=1");
    expect(cleanBuild).toContain("docker-container");
    expect(cleanBuild).toContain("peer credential native binding unavailable");
    expect(cleanBuild).toContain("assertTrackedSnapshot(destination)");
    expect(cleanBuild).toContain(
      "mkdirSync(destination, { recursive: true, mode: 0o700 })",
    );
    expect(cleanBuild).toContain("chmodSync(destination, 0o700)");
    const npmReleaseTest = readFileSync(
      join(REPO_ROOT, "packages/agenc/test/npm-release.test.mjs"),
      "utf8",
    );
    expect(npmReleaseTest).toContain(
      'process.env.AGENC_BUILD_COMMIT?.trim() || "a".repeat(40)',
    );
    expect(cleanBuild).toContain('"pack",\n          "--json"');
    expect(cleanBuild).not.toContain('"scripts/npm-release.mjs",\n          "pack"');
    expect(cleanBuild).toContain('"--ignore-scripts=true"');
    expect(cleanBuild).not.toContain('"--ignore-scripts=false"');
    expect(cleanBuild).toContain(
      "The build and package-readiness steps were executed",
    );
    expect(cleanBuild).toContain(".git-free checkout-index snapshots before a");
    expect(cleanBuild).toContain(
      "must not be synthesized from --allow-partial output",
    );
    expect(cleanBuild).not.toContain(
      'join(artifacts, "agenc-runtime-manifest.json")',
    );
    expect(cleanBuild).toContain("node_modules/@tetsuo-ai/runtime/dist/VERSION");
    expect(cleanBuild).toContain("/data:rw,nosuid,nodev,noexec");
    expect(cleanBuild).toContain(
      "AGENC_NATIVE_PEER_CREDENTIAL_ADDON=/data/evil.node",
    );
    expect(cleanBuild).toContain("checkedJavaScriptProgram(");
    expect(cleanBuild).toContain('"hardened container runtime smoke"');
    const hardenedSmoke = cleanBuild.match(
      /checkedJavaScriptProgram\(\s*String\.raw`([\s\S]*?)`,\s*"hardened container runtime smoke"/,
    );
    expect(hardenedSmoke).not.toBeNull();
    const hardenedSmokeSource = hardenedSmoke?.[1] ?? "";
    expect(() => new Function(hardenedSmokeSource)).not.toThrow();
    expect(hardenedSmokeSource).toContain('.split("\\n")');
    expect(hardenedSmokeSource).not.toContain('.split("\\\\n")');
    expect(cleanBuild).toContain('!== "required\\n"');
    expect(cleanBuild).toContain('"--cap-drop"');
    expect(cleanBuild.match(/checkoutIndex\(dockerSources\[/g)).toHaveLength(2);

    const publishNpm = readFileSync(
      join(REPO_ROOT, ".github/workflows/publish-npm.yml"),
      "utf8",
    );
    expect(publishNpm).toContain(
      "--pattern 'agenc-runtime-*.tar.gz.sigstore.json'",
    );

    const dockerignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    expect(dockerignore).toMatch(/^\*\*$/m);
    expect(dockerignore).toContain("!runtime/**");
    expect(dockerignore).toContain("**/.env.*");
    expect(dockerignore).not.toContain("!scripts/**");
    expect(dockerignore).not.toContain("!.npmrc");
  });

  test("package lifecycle contracts build exports and reject incomplete launchers", () => {
    const runtime = JSON.parse(
      readFileSync(join(REPO_ROOT, "runtime/package.json"), "utf8"),
    ) as { scripts: Record<string, string>; files: string[] };
    const sdk = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/agenc-sdk/package.json"), "utf8"),
    ) as { scripts: Record<string, string>; files: string[] };
    const launcher = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/agenc/package.json"), "utf8"),
    ) as { scripts: Record<string, string>; files: string[] };
    expect(runtime.scripts.prepack).toBe("npm run build");
    expect(sdk.scripts.prepack).toBe("npm run build");
    expect(launcher.scripts.prepack).toContain("check-package-ready.mjs");
    expect(runtime.files).toContain("dist");
    expect(sdk.files).toContain("dist");
    expect(launcher.files).toContain("generated/agenc-runtime-manifest-v2.json");
    expect(launcher.files).not.toContain("generated/agenc-runtime-manifest.json");
    expect(launcher.files).not.toContain("scripts");
    expect(launcher.files).toContain("scripts/postinstall.mjs");
  });
});
