import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "..");

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

  test("the active release workflow uses pinned inputs and proves two native builds match", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/release-runtime.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/npm ci --prefix .* --no-audit --no-fund/);
    expect(workflow).not.toMatch(/run:\s+npm install(?! --global)/);
    expect(workflow).toContain('NODE_VERSION: "25.9.0"');
    expect(workflow).toContain('NPM_VERSION: "11.17.0"');
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
    expect(workflow).toContain("AGENC_NPM_DISTRIBUTION_SHA256=");
    expect(workflow).toContain("npm_config_nodedir=");
    expect(workflow).toContain("nodeDistributions");
    expect(workflow).toContain("nodeHeaders");
    expect(workflow).toContain("Get-FileHash -Algorithm SHA256");
    expect(workflow).toContain("Validate the reviewed macOS runner and native toolchain");
    expect(workflow).toContain("Validate and activate the reviewed Windows runner and native toolchain");
    expect(workflow).toContain("hostedRunners");
    expect(workflow).toContain("Assert-Exact 'ImageVersion'");
    expect(workflow).toContain("Assert-Exact 'active MSVC tools version'");
    expect(workflow).toContain("MSVC compiler identity");
    const nativeJob = workflow.slice(workflow.indexOf("\n  native-tarball:"));
    expect(nativeJob.indexOf("Validate the reviewed macOS runner")).toBeLessThan(
      nativeJob.indexOf("npm ci --prefix"),
    );
    expect(nativeJob.indexOf("Validate and activate the reviewed Windows runner")).toBeLessThan(
      nativeJob.indexOf("npm ci --prefix"),
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
    expect(builder).toContain('"ci"');
    expect(builder).toContain('"--workspace=@tetsuo-ai/runtime"');
    expect(builder).toContain("writeCanonicalArchive");
    expect(builder).toContain("release Linux signed RPM content inventory does not match");
    expect(builder).toContain("assertHostedRunnerContract");
    expect(builder).not.toMatch(/\[\s*"install",\s*runtimeTgz/);
    const nativeContract = JSON.parse(
      readFileSync(join(REPO_ROOT, "release-toolchain.json"), "utf8"),
    ) as {
      hostedRunners: Record<string, Record<string, string>>;
      linux: {
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
        imageVersion: "20260706.0213.1",
        runnerArch: "ARM64",
        xcodeVersion: "16.4",
        xcodeBuild: "16F6",
        macosSdkVersion: "15.5",
        clangVersion: "Apple clang version 17.0.0 (clang-1700.0.13.5)",
      },
      "darwin-x64": {
        runnerLabel: "macos-15-intel",
        imageVersion: "20260629.0276.1",
        runnerArch: "X64",
      },
      "win-x64": {
        runnerLabel: "windows-2025",
        imageOS: "win25",
        imageVersion: "20260628.181.1",
        runnerArch: "X64",
        visualStudioVersion: "17.14.37411.7",
        msvcToolsVersion: "14.44.35211",
        windowsSdkVersion: "10.0.26100.0",
      },
    });
    expect(nativeContract.linux.rpmContentInventory).toEqual({
      schemaVersion: 1,
      format:
        "name|epoch|version|release|arch|sha256header|payloaddigest|payloaddigestalgo|rsaheader-pgpsig",
      signatureKeyIds: ["15af5dac6d745a60"],
      sha256: {
        x64: "19188b90457ed82a19099d05015df66773c81e1cb93612e21db4b5e5a931b905",
        arm64: "304f9e337e2f2515bd9550b4ac6a75de88c240da45fdb9e51a16441171421172",
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
    const packJob = workflow.slice(0, workflow.indexOf("\n  publish:"));
    expect(packJob).not.toContain("id-token: write");
    expect(packJob).not.toContain("actions/attest@");
    expect(workflow).toContain('test "$GITHUB_REF_TYPE" = tag');
    expect(workflow).toContain('expected_ref="refs/tags/agenc-v${version}"');
    expect(workflow).toContain('test "$REPOSITORY_VISIBILITY" = public');
    expect(workflow.match(/git merge-base --is-ancestor/g)).toHaveLength(2);
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
    expect(workflow).toContain("npm test --workspace=@tetsuo-ai/agenc");
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
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
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
    expect(cleanBuild).toContain('!== "required\\\\n"');
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
