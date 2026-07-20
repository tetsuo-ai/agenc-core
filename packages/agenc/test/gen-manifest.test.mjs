import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { validateRuntimeArchive } from "../lib/runtime-archive.mjs";
import {
  frozenLegacyManifestBytes,
  generateManifest,
  LEGACY_BRIDGE_CONTRACT,
  projectLegacyManifest,
  reviewedLegacyBridgeIdentity,
  validateLegacyBridgeManifest,
} from "../scripts/gen-manifest.mjs";
import { validateLauncherManifest } from "../scripts/check-package-ready.mjs";
import {
  canonicalAttestationVerificationArgs,
  isolatedGitHubCliEnvironment,
  prepareReleaseAssets,
  RELEASE_ATTESTATION_POLICY,
} from "../scripts/prepare-release-assets.mjs";

const runtimeVersion = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "..", "..", "..", "runtime", "package.json"), "utf8"),
).version;
const tag = `agenc-v${runtimeVersion}`;
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const releaseToolchain = JSON.parse(
  readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
);
const sourceCommit = process.env.AGENC_BUILD_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const sourceDateEpoch = Number(
  process.env.SOURCE_DATE_EPOCH || execFileSync("git", ["show", "-s", "--format=%ct", sourceCommit], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
);
const lockfileSha256 = sha256(readFileSync(join(repoRoot, "package-lock.json")));
const resolveSourceTagCommit = () => sourceCommit;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("release attestation gate exactly matches the official client policy", () => {
  const commit = "a".repeat(40);
  const sourceRef = `refs/tags/${LEGACY_BRIDGE_CONTRACT.releaseTag}`;
  assert.deepEqual(RELEASE_ATTESTATION_POLICY, {
    repository: "tetsuo-ai/agenc-core",
    signerWorkflow: "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml",
    hostname: "github.com",
    oidcIssuer: "https://token.actions.githubusercontent.com",
    predicateType: "https://slsa.dev/provenance/v1",
  });
  assert.deepEqual(
    canonicalAttestationVerificationArgs(
      "/private/runtime.tar.gz",
      "/private/runtime.tar.gz.sigstore.json",
      { build: { sourceCommit: commit, sourceRef } },
    ),
    [
      "attestation",
      "verify",
      "/private/runtime.tar.gz",
      "--repo",
      "tetsuo-ai/agenc-core",
      "--bundle",
      "/private/runtime.tar.gz.sigstore.json",
      "--signer-workflow",
      "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml",
      "--signer-digest",
      commit,
      "--source-digest",
      commit,
      "--source-ref",
      sourceRef,
      "--hostname",
      "github.com",
      "--cert-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--deny-self-hosted-runners",
    ],
  );
  assert.throws(
    () => canonicalAttestationVerificationArgs("artifact", "bundle", {
      build: { sourceCommit: "0".repeat(39), sourceRef },
    }),
    /exact source commit/,
  );
});

test("release attestation gate isolates gh configuration and disables auxiliary egress", () => {
  const work = join(tmpdir(), "agenc-private-gh-test");
  const config = join(work, "config");
  assert.deepEqual(
    isolatedGitHubCliEnvironment(work, {
      PATH: "/trusted/bin",
      HTTPS_PROXY: "https://proxy.invalid",
      HOME: "/ambient/home",
      GH_TOKEN: "ambient-token",
      GITHUB_TOKEN: "ambient-token",
      GH_NO_UPDATE_NOTIFIER: "0",
      GH_TELEMETRY: "1",
    }),
    {
      PATH: "/trusted/bin",
      HTTPS_PROXY: "https://proxy.invalid",
      HOME: work,
      USERPROFILE: work,
      APPDATA: config,
      LOCALAPPDATA: config,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: config,
      GH_CONFIG_DIR: config,
      GH_HOST: "github.com",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      GH_SPINNER_DISABLED: "1",
      GH_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
      TEMP: work,
      TMP: work,
    },
  );
});

function tarEntry(name, type, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(type === "5" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}

function tinyRuntimeArchive(body) {
  const payload = Buffer.from(body);
  return gzipSync(Buffer.concat([
    ...tarEntry("node_modules/", "5"),
    ...tarEntry("node_modules/test-package/", "5"),
    ...tarEntry("node_modules/test-package/index.js", "0", payload),
    Buffer.alloc(1024),
  ]), { level: 9, mtime: 0 });
}

function addArtifact(directory, platform, arch, body) {
  const nodeMajor = releaseToolchain.nodeMajor;
  const nodeModuleAbi = releaseToolchain.nodeModuleAbi;
  const artifact =
    `agenc-runtime-${runtimeVersion}-${platform}-${arch}-node${nodeMajor}-abi${nodeModuleAbi}.tar.gz`;
  const bytes = tinyRuntimeArchive(body);
  const artifactPath = join(directory, artifact);
  writeFileSync(artifactPath, bytes);
  const archiveValidation = validateRuntimeArchive(artifactPath, platform);
  const rpmContentInventorySha256 = platform === "linux"
    ? releaseToolchain.linux.rpmContentInventory.sha256[arch]
    : undefined;
  const key = `${platform}-${arch}`;
  const hostedRunner = releaseToolchain.hostedRunners[key];
  const hostedBuilder = hostedRunner === undefined
    ? undefined
    : `github-hosted:${hostedRunner.runnerLabel}:${hostedRunner.imageOS}:` +
      `${hostedRunner.imageVersion}:${hostedRunner.runnerArch}`;
  const compilerIdentity = platform === "darwin"
    ? hostedRunner.clangVersion
    : platform === "win"
      ? `Microsoft (R) C/C++ Optimizing Compiler Version ${hostedRunner.msvcCompilerVersion} for x64`
      : "test cc 12.2.1";
  const meta = {
    platform,
    arch,
    runtimeVersion,
    artifact,
    sha256: sha256(bytes),
    bytes: bytes.length,
    sourceCommit,
    sourceDateEpoch,
    buildTime: new Date(sourceDateEpoch * 1000).toISOString(),
    lockfileSha256,
    dependencyTreeSha256: "c".repeat(64),
    dependencyPackages: 1,
    nodeVersion: `v${releaseToolchain.nodeVersion}`,
    nodeMajor,
    nodeModuleAbi,
    nodeApiVersion: releaseToolchain.nodeApiVersion,
    npmVersion: releaseToolchain.npmVersion,
    artifactProfile: "release",
    nativeToolchain: {
      schemaVersion: 1,
      builder: platform === "linux"
        ? `${releaseToolchain.linux.containerImage}+rpm-content-sha256:${rpmContentInventorySha256}`
        : hostedBuilder,
      cc: compilerIdentity,
      cxx: compilerIdentity,
      python: "Python 3.12.13",
      make: "GNU Make 4.2.1",
      buildFlags: {},
      nodeDistributionFile: releaseToolchain.nodeDistributions[`${platform}-${arch}`].file,
      nodeDistributionSha256: releaseToolchain.nodeDistributions[`${platform}-${arch}`].sha256,
      nodeHeadersFile: releaseToolchain.nodeHeaders.file,
      nodeHeadersSha256: releaseToolchain.nodeHeaders.sha256,
      npmDistributionFile: releaseToolchain.npmDistribution.file,
      npmDistributionSha256: releaseToolchain.npmDistribution.sha256,
      ...(platform !== "linux"
        ? {
            runnerLabel: hostedRunner.runnerLabel,
            runnerImage: hostedRunner.imageOS,
            runnerImageVersion: hostedRunner.imageVersion,
            runnerArch: hostedRunner.runnerArch,
          }
        : {}),
      ...(platform === "darwin"
        ? {
            xcode: `Xcode ${hostedRunner.xcodeVersion}\nBuild version ${hostedRunner.xcodeBuild}`,
            sdk: hostedRunner.macosSdkVersion,
          }
        : {}),
      ...(platform === "win"
        ? {
            nodeImportLibraryFile: releaseToolchain.nodeImportLibraries[key].file,
            nodeImportLibrarySha256: releaseToolchain.nodeImportLibraries[key].sha256,
            nodeImportLibraryBytes: releaseToolchain.nodeImportLibraries[key].bytes,
            nodeCommonGypiFile: releaseToolchain.nodeHeaders.windowsCommonGypi.path,
            nodeCommonGypiSourceSha256:
              releaseToolchain.nodeHeaders.windowsCommonGypi.sourceSha256,
            nodeCommonGypiReleaseSha256:
              releaseToolchain.nodeHeaders.windowsCommonGypi.releaseSha256,
            nodeCommonGypiTransformation:
              releaseToolchain.nodeHeaders.windowsCommonGypi.transformation,
            visualStudioVersion: hostedRunner.visualStudioVersion,
            visualStudioInstallPath: hostedRunner.visualStudioInstallPath,
            msvcToolsVersion: hostedRunner.msvcToolsVersion,
            windowsSdkVersion: hostedRunner.windowsSdkVersion,
            compilerDetails: `${compilerIdentity}\nCompiler Passes: reviewed fixture`,
            msvcCompilerSha256: "1".repeat(64),
            msvcLinkerSha256: "2".repeat(64),
          }
        : {}),
      ...(platform === "linux"
        ? {
            rpmContentInventorySchemaVersion:
              releaseToolchain.linux.rpmContentInventory.schemaVersion,
            rpmContentInventoryFormat: releaseToolchain.linux.rpmContentInventory.format,
            rpmContentInventorySha256,
            rpmSigningKeyIds: releaseToolchain.linux.rpmContentInventory.signatureKeyIds,
            rpmPackages: Object.values(releaseToolchain.linux.builderPackages),
          }
        : {}),
    },
    archiveFormat: "test",
    archiveValidation: {
      policy: "agenc-runtime-archive-v1",
      entries: archiveValidation.entries,
      uncompressedBytes: archiveValidation.uncompressedBytes,
    },
    bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    ...(platform === "linux"
      ? {
          libcFamily: "glibc",
          minimumGlibcVersion: "2.17",
          minimumGlibcxxVersion: "3.4.21",
          minimumCxxAbiVersion: "1.3.9",
          buildGlibcVersion: "2.28",
        }
      : {}),
    ...(platform === "darwin" ? { minimumMacosVersion: "13.5" } : {}),
  };
  writeFileSync(join(directory, `${artifact}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(
    join(directory, `${artifact}.sigstore.json`),
    `${JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", artifact })}\n`,
  );
  return { artifact, meta };
}

function bridgeV2Fixture() {
  const bridge = LEGACY_BRIDGE_CONTRACT;
  const artifacts = [
    ["win", "x64"],
    ["linux", "x64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
  ].map(([platform, arch], index) => {
    const key = `${platform}-${arch}`;
    return {
      platform,
      arch,
      runtimeVersion: bridge.runtimeVersion,
      nodeMajor: bridge.nodeMajor,
      nodeModuleAbi: bridge.nodeModuleAbi,
      nodeApiVersion: bridge.nodeApiVersion,
      url:
        `https://github.com/${bridge.releaseRepository}/releases/download/${bridge.releaseTag}/` +
        `agenc-runtime-${bridge.runtimeVersion}-${key}-node${bridge.nodeMajor}` +
        `-abi${bridge.nodeModuleAbi}.tar.gz`,
      sha256: index.toString(16).repeat(64),
      bytes: index + 1,
      metadataSha256: (index + 5).toString(16).repeat(64),
      attestationUrl:
        `https://github.com/${bridge.releaseRepository}/releases/download/${bridge.releaseTag}/` +
        `agenc-runtime-${bridge.runtimeVersion}-${key}-node${bridge.nodeMajor}` +
        `-abi${bridge.nodeModuleAbi}.tar.gz.sigstore.json`,
      attestationSha256: (index + 10).toString(16).repeat(64),
      attestationBytes: index + 10,
      nativeToolchain: { schemaVersion: 1 },
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    };
  });
  return {
    manifestVersion: 2,
    runtimeVersion: bridge.runtimeVersion,
    releaseRepository: bridge.releaseRepository,
    releaseTag: bridge.releaseTag,
    build: {
      sourceCommit: "a".repeat(40),
      sourceRef: `refs/tags/${bridge.releaseTag}`,
      sourceDateEpoch: 1,
      lockfileSha256: "b".repeat(64),
      nodeVersion: bridge.nodeVersion,
      nodeMajor: bridge.nodeMajor,
      nodeModuleAbi: bridge.nodeModuleAbi,
      nodeApiVersion: bridge.nodeApiVersion,
      npmVersion: "11.12.1",
      artifactProfile: "release",
    },
    artifacts,
  };
}

test("v0.7.2 legacy projection is deterministic, minimal, and Node 25 exact", () => {
  const first = projectLegacyManifest(bridgeV2Fixture());
  const reordered = bridgeV2Fixture();
  reordered.artifacts.reverse();
  const second = projectLegacyManifest(reordered);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), [
    "manifestVersion",
    "runtimeVersion",
    "releaseRepository",
    "releaseTag",
    "artifacts",
  ]);
  assert.equal(first.manifestVersion, 1);
  assert.deepEqual(
    first.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`),
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64"],
  );
  for (const artifact of first.artifacts) {
    assert.deepEqual(Object.keys(artifact), [
      "platform", "arch", "runtimeVersion", "url", "sha256", "bytes", "bins",
    ]);
    assert.match(artifact.url, /-node25-abi141\.tar\.gz$/);
  }
  validateLegacyBridgeManifest(first);
  const extraField = structuredClone(first);
  extraField.artifacts[0].unexpected = true;
  assert.throws(
    () => validateLegacyBridgeManifest(extraField),
    /fields are not the exact legacy v1 schema/,
  );
  const reorderedLegacy = structuredClone(first);
  reorderedLegacy.artifacts.reverse();
  assert.throws(
    () => validateLegacyBridgeManifest(reorderedLegacy),
    /not canonically ordered/,
  );
});

test("legacy bridge projection rejects drift and duplicate platform entries", () => {
  const cases = [
    ["version", (manifest) => { manifest.runtimeVersion = "0.6.2"; }, /runtimeVersion 0\.7\.2/],
    ["Node", (manifest) => { manifest.build.nodeVersion = "v24.18.0"; }, /nodeVersion v25\.9\.0/],
    ["ABI", (manifest) => { manifest.artifacts[0].nodeModuleAbi = "137"; }, /source artifact is invalid/],
    ["URL", (manifest) => { manifest.artifacts[0].url = "https://example.invalid/runtime.tar.gz"; }, /source artifact is invalid/],
    ["duplicate", (manifest) => {
      manifest.artifacts[0] = structuredClone(manifest.artifacts[1]);
    }, /duplicate platform/],
  ];
  for (const [label, mutate, expected] of cases) {
    const manifest = bridgeV2Fixture();
    mutate(manifest);
    assert.throws(() => projectLegacyManifest(manifest), expected, label);
  }
});

test("future releases can only reuse exact pinned canonical v0.7.2 legacy bytes", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-frozen-legacy-"));
  try {
    const path = join(work, "agenc-runtime-manifest.json");
    const canonical = Buffer.from(`${JSON.stringify(projectLegacyManifest(bridgeV2Fixture()), null, 2)}\n`);
    writeFileSync(path, canonical);
    assert.deepEqual(
      frozenLegacyManifestBytes({ path, sha256: sha256(canonical), bytes: canonical.length }),
      canonical,
    );
    assert.throws(
      () => frozenLegacyManifestBytes({
        path,
        sha256: "0".repeat(64),
        bytes: canonical.length,
      }),
      /pinned byte identity/,
    );
    const noncanonical = Buffer.concat([canonical, Buffer.from("\n")]);
    writeFileSync(path, noncanonical);
    assert.throws(
      () => frozenLegacyManifestBytes({
        path,
        sha256: sha256(noncanonical),
        bytes: noncanonical.length,
      }),
      /bytes are not canonical/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("future release tooling accepts only the centrally reviewed legacy bridge identity", () => {
  assert.deepEqual(reviewedLegacyBridgeIdentity(releaseToolchain), {
    sha256: "b48635506a687be44d763c606fff4604f701983f6fe049aa1ff10b4211755f5d",
    bytes: 2318,
  });
  for (const mutation of [
    { status: "pending-v0.7.2-publication" },
    { sha256: null },
    { bytes: null },
  ]) {
    assert.throws(
      () => reviewedLegacyBridgeIdentity({
        ...releaseToolchain,
        legacyBridge: { ...releaseToolchain.legacyBridge, ...mutation },
      }),
      /must be pinned in release-toolchain\.json/,
    );
  }
  assert.throws(
    () => reviewedLegacyBridgeIdentity({
      ...releaseToolchain,
      legacyBridge: { ...releaseToolchain.legacyBridge, releaseTag: "agenc-v0.6.3" },
    }),
    /legacy bridge contract is invalid/,
  );
  for (const script of ["gen-manifest.mjs", "prepare-release-assets.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "packages", "agenc", "scripts", script), "--frozen-legacy-sha256", "a".repeat(64)],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not accepted; use the reviewed release-toolchain identity/);
  }
});

test("manifest generation verifies bytes and is independent of input creation order", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-test-"));
  try {
    const first = join(work, "first");
    const second = join(work, "second");
    mkdirSync(first);
    mkdirSync(second);
    addArtifact(first, "linux", "x64", "linux-x64");
    addArtifact(first, "linux", "arm64", "linux-arm64");
    addArtifact(second, "linux", "arm64", "linux-arm64");
    addArtifact(second, "linux", "x64", "linux-x64");
    const firstOutput = join(work, "first.json");
    const secondOutput = join(work, "second.json");
    await generateManifest({
      tag,
      artifactsDir: first,
      baseUrl: `https://example.invalid/${tag}`,
      allowPartial: true,
      outputPath: firstOutput,
    });
    await generateManifest({
      tag,
      artifactsDir: second,
      baseUrl: `https://example.invalid/${tag}`,
      allowPartial: true,
      outputPath: secondOutput,
    });
    assert.equal(readFileSync(firstOutput, "utf8"), readFileSync(secondOutput, "utf8"));
    const manifest = JSON.parse(readFileSync(firstOutput, "utf8"));
    assert.deepEqual(
      manifest.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`),
      ["linux-arm64", "linux-x64"],
    );
    assert.equal(manifest.build.sourceCommit, sourceCommit);
    assert.equal(manifest.build.sourceRef, `refs/tags/${tag}`);
    assert.equal(manifest.build.nodeModuleAbi, releaseToolchain.nodeModuleAbi);
    assert.equal(manifest.manifestVersion, 2);
    for (const artifact of manifest.artifacts) {
      assert.equal(artifact.attestationUrl, `${artifact.url}.sigstore.json`);
      assert.match(artifact.attestationSha256, /^[0-9a-f]{64}$/);
      assert.ok(artifact.attestationBytes > 0);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("release asset preparation revalidates and binds every provenance sidecar", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-release-assets-test-"));
  try {
    const artifacts = join(work, "download");
    const output = join(work, "upload");
    const manifestPath = join(work, "agenc-runtime-manifest-v2.json");
    const legacyManifestPath = join(work, "agenc-runtime-manifest.json");
    const sbomPath = join(work, "agenc-core.spdx.json");
    mkdirSync(artifacts);
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win", "x64"],
    ]) {
      addArtifact(artifacts, platform, arch, `${platform}-${arch}`);
    }
    await generateManifest({
      tag,
      artifactsDir: artifacts,
      outputPath: manifestPath,
      legacyOutputPath: legacyManifestPath,
      resolveSourceTagCommit,
    });
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "generate-spdx-sbom.mjs"),
        "--output", sbomPath,
        "--source-commit", sourceCommit,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, SOURCE_DATE_EPOCH: String(sourceDateEpoch) },
      },
    );

    const readSourceFile = (_commit, path) => readFileSync(join(repoRoot, path));
    prepareReleaseAssets({
      artifactsRoot: artifacts,
      manifestPath,
      legacyManifestPath,
      sbomPath,
      output,
      requireCleanCheckout: false,
      verifySourceTag: false,
      readSourceFile,
    });
    const outputNames = readdirSync(output).sort();
    assert.equal(outputNames.length, 21);
    assert.ok(outputNames.includes("SHA256SUMS"));
    assert.equal(statSync(join(output, "install.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(join(output, "agenc-runtime-manifest.json")).mode & 0o777, 0o644);
    assert.equal(statSync(join(output, "agenc-runtime-manifest-v2.json")).mode & 0o777, 0o644);
    assert.equal(readFileSync(join(output, "SHA256SUMS"), "utf8").trim().split("\n").length, 20);

    const attestedOutput = join(work, "attested-upload");
    const verifiedNames = [];
    prepareReleaseAssets({
      artifactsRoot: artifacts,
      manifestPath,
      legacyManifestPath,
      sbomPath,
      output: attestedOutput,
      requireCleanCheckout: false,
      verifySourceTag: false,
      verifyAttestations: true,
      readSourceFile,
      verifyAttestation(source, bundle, manifest) {
        verifiedNames.push(basename(source));
        const expectedBundle = basename(source).endsWith(".meta.json")
          ? `${basename(source).slice(0, -".meta.json".length)}.sigstore.json`
          : `${basename(source)}.sigstore.json`;
        assert.equal(basename(bundle), expectedBundle);
        assert.equal(manifest.build.sourceCommit, sourceCommit);
      },
    });
    assert.equal(verifiedNames.length, 10);
    assert.equal(verifiedNames.filter((name) => name.endsWith(".meta.json")).length, 5);
    assert.equal(
      readdirSync(attestedOutput).filter((name) => name.endsWith(".sigstore.json")).length,
      5,
    );
    assert.equal(readdirSync(attestedOutput).length, 21);

    const pinnedGh = join(work, "pinned-gh");
    const pinnedGhLog = join(work, "pinned-gh.log");
    writeFileSync(
      pinnedGh,
      `#!/bin/sh\nprintf 'verified\\n' >> ${JSON.stringify(pinnedGhLog)}\n`,
    );
    chmodSync(pinnedGh, 0o755);
    prepareReleaseAssets({
      artifactsRoot: artifacts,
      manifestPath,
      legacyManifestPath,
      sbomPath,
      output: join(work, "pinned-gh-upload"),
      requireCleanCheckout: false,
      verifySourceTag: false,
      verifyAttestations: true,
      githubCliPath: pinnedGh,
      readSourceFile,
    });
    assert.equal(readFileSync(pinnedGhLog, "utf8").trim().split("\n").length, 10);
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath,
        output: join(work, "ambient-gh-rejected"),
        requireCleanCheckout: false,
        verifySourceTag: false,
        verifyAttestations: true,
        githubCliPath: "gh",
        readSourceFile,
      }),
      /absolute checksum-pinned GitHub CLI path/,
    );
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath,
        output: join(work, "rejected-attestation-upload"),
        requireCleanCheckout: false,
        verifySourceTag: false,
        verifyAttestations: true,
        readSourceFile,
        verifyAttestation() {
          throw new Error("attestation policy rejected fixture");
        },
      }),
      /attestation policy rejected fixture/,
    );

    const fakeSbomPath = join(work, "fake.spdx.json");
    const fakeSbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    fakeSbom.packages = fakeSbom.packages.slice(0, 1);
    writeFileSync(fakeSbomPath, `${JSON.stringify(fakeSbom, null, 2)}\n`);
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath: fakeSbomPath,
        output: join(work, "fake-sbom-upload"),
        requireCleanCheckout: false,
        verifySourceTag: false,
        readSourceFile,
      }),
      /SBOM bytes do not match/,
    );

    const reviewedLegacy = readFileSync(legacyManifestPath);
    const detachedLegacy = JSON.parse(reviewedLegacy.toString("utf8"));
    detachedLegacy.artifacts[0].sha256 = "0".repeat(64);
    writeFileSync(legacyManifestPath, `${JSON.stringify(detachedLegacy, null, 2)}\n`);
    const detachedLegacyOutput = join(work, "detached-legacy-upload");
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath,
        output: detachedLegacyOutput,
        requireCleanCheckout: false,
        verifySourceTag: false,
        readSourceFile,
      }),
      /not the deterministic projection/,
    );
    assert.equal(existsSync(detachedLegacyOutput), false);
    writeFileSync(legacyManifestPath, reviewedLegacy);

    const bundle = readdirSync(artifacts).find((name) => name.endsWith(".sigstore.json"));
    const bundlePath = join(artifacts, bundle);
    const reviewedBundle = readFileSync(bundlePath);
    writeFileSync(bundlePath, `${JSON.stringify({ tampered: true })}\n`);
    const tamperedBundleOutput = join(work, "tampered-bundle-upload");
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath,
        output: tamperedBundleOutput,
        requireCleanCheckout: false,
        verifySourceTag: false,
        readSourceFile,
      }),
      /attestation binding failed/,
    );
    assert.equal(existsSync(tamperedBundleOutput), false);
    writeFileSync(bundlePath, reviewedBundle);

    const sidecar = readdirSync(artifacts).find((name) => name.endsWith(".meta.json"));
    writeFileSync(join(artifacts, sidecar), "{}\n");
    const tamperedOutput = join(work, "tampered-upload");
    assert.throws(
      () => prepareReleaseAssets({
        artifactsRoot: artifacts,
        manifestPath,
        legacyManifestPath,
        sbomPath,
        output: tamperedOutput,
        requireCleanCheckout: false,
        verifySourceTag: false,
        readSourceFile,
      }),
      /provenance binding failed/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("public manifest generation binds the named tag to the exact checkout commit", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-tag-binding-"));
  try {
    addArtifact(work, "linux", "x64", "tag-binding");
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        outputPath: join(work, "manifest.json"),
        resolveSourceTagCommit: () => "f".repeat(40),
      }),
      /release source tag .* not checkout/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("public manifest generation rejects detached repositories and base URLs", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-public-origin-"));
  try {
    addArtifact(work, "linux", "x64", "public-origin");
    await assert.rejects(
      generateManifest({
        repo: "attacker/releases",
        tag,
        artifactsDir: work,
        outputPath: join(work, "detached-repo.json"),
        resolveSourceTagCommit,
      }),
      /public manifests must use tetsuo-ai\/agenc-releases/,
    );
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://mirror.example.invalid/${tag}`,
        outputPath: join(work, "detached-base.json"),
        resolveSourceTagCommit,
      }),
      /base URL is not the canonical immutable release URL/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest collection rejects duplicate artifact filenames across download directories", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-duplicate-download-"));
  try {
    const first = join(work, "first");
    const second = join(work, "second");
    mkdirSync(first);
    mkdirSync(second);
    const { artifact } = addArtifact(first, "linux", "x64", "first");
    writeFileSync(join(second, artifact), "duplicate");
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "manifest.json"),
      }),
      /duplicate artifact filename/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation accepts one gh-run-download directory level", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-nested-test-"));
  try {
    const nested = join(work, "agenc-runtime-linux-x64");
    mkdirSync(nested);
    addArtifact(nested, "linux", "x64", "nested-linux-x64");
    const outputPath = join(work, "manifest.json");
    const { manifest } = await generateManifest({
      tag,
      artifactsDir: work,
      baseUrl: `https://example.invalid/${tag}`,
      allowPartial: true,
      outputPath,
    });
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.artifacts[0].platform, "linux");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("release manifest generation requires one canonical bounded Sigstore bundle", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-sigstore-test-"));
  try {
    const { artifact } = addArtifact(work, "linux", "x64", "sigstore");
    const bundlePath = join(work, `${artifact}.sigstore.json`);
    rmSync(bundlePath);
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "missing.json"),
      }),
      /canonical Sigstore bundle is missing/,
    );
    writeFileSync(bundlePath, "[]\n");
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "invalid.json"),
      }),
      /canonical Sigstore bundle is invalid JSON/,
    );
    writeFileSync(bundlePath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "oversized.json"),
      }),
      /canonical Sigstore bundle has an invalid byte count/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("full release manifest covers the exact five-platform matrix and enforces the macOS floor", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-full-test-"));
  try {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win", "x64"],
    ]) {
      addArtifact(work, platform, arch, `${platform}-${arch}`);
    }
    const outputPath = join(work, "manifest.json");
    const legacyOutputPath = join(work, "agenc-runtime-manifest.json");
    const { manifest, legacyManifest } = await generateManifest({
      tag,
      artifactsDir: work,
      outputPath,
      legacyOutputPath,
      resolveSourceTagCommit,
    });
    assert.deepEqual(
      manifest.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`),
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64"],
    );
    assert.deepEqual(legacyManifest, projectLegacyManifest(manifest));
    assert.equal(
      readFileSync(legacyOutputPath, "utf8"),
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
    );
    assert.ok(
      manifest.artifacts
        .filter((artifact) => artifact.platform === "darwin")
        .every((artifact) => artifact.minimumMacosVersion === releaseToolchain.macos.minimumVersion),
    );
    assert.equal(
      validateLauncherManifest({ manifestPath: outputPath }).artifacts.length,
      5,
    );
    const validManifestText = readFileSync(outputPath, "utf8");
    manifest.artifacts[0].url = "https://example.invalid/detached.tar.gz";
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => validateLauncherManifest({ manifestPath: outputPath }),
      /canonical immutable release asset URL/,
    );
    writeFileSync(outputPath, validManifestText);

    const detachedImportLibraryManifest = JSON.parse(validManifestText);
    const windowsArtifact = detachedImportLibraryManifest.artifacts.find(
      (artifact) => artifact.platform === "win" && artifact.arch === "x64",
    );
    assert.deepEqual(
      {
        file: windowsArtifact.nativeToolchain.nodeCommonGypiFile,
        sourceSha256: windowsArtifact.nativeToolchain.nodeCommonGypiSourceSha256,
        releaseSha256: windowsArtifact.nativeToolchain.nodeCommonGypiReleaseSha256,
        transformation: windowsArtifact.nativeToolchain.nodeCommonGypiTransformation,
      },
      {
        file: releaseToolchain.nodeHeaders.windowsCommonGypi.path,
        sourceSha256: releaseToolchain.nodeHeaders.windowsCommonGypi.sourceSha256,
        releaseSha256: releaseToolchain.nodeHeaders.windowsCommonGypi.releaseSha256,
        transformation: releaseToolchain.nodeHeaders.windowsCommonGypi.transformation,
      },
    );
    windowsArtifact.nativeToolchain.nodeImportLibraryBytes += 1;
    writeFileSync(
      outputPath,
      `${JSON.stringify(detachedImportLibraryManifest, null, 2)}\n`,
    );
    assert.throws(
      () => validateLauncherManifest({ manifestPath: outputPath }),
      /Node import library evidence does not match/,
    );
    writeFileSync(outputPath, validManifestText);

    const detachedCommonGypiManifest = JSON.parse(validManifestText);
    const detachedCommonGypiArtifact = detachedCommonGypiManifest.artifacts.find(
      (artifact) => artifact.platform === "win" && artifact.arch === "x64",
    );
    detachedCommonGypiArtifact.nativeToolchain.nodeCommonGypiReleaseSha256 =
      "0".repeat(64);
    writeFileSync(
      outputPath,
      `${JSON.stringify(detachedCommonGypiManifest, null, 2)}\n`,
    );
    assert.throws(
      () => validateLauncherManifest({ manifestPath: outputPath }),
      /sanitized Node common\.gypi evidence does not match/,
    );
    writeFileSync(outputPath, validManifestText);

    const darwinMeta = readdirSync(work).find((name) => name.includes("darwin-arm64") && name.endsWith(".meta.json"));
    const darwinMetaPath = join(work, darwinMeta);
    const meta = JSON.parse(readFileSync(darwinMetaPath, "utf8"));
    meta.minimumMacosVersion = "99.0";
    writeFileSync(darwinMetaPath, `${JSON.stringify(meta, null, 2)}\n`);
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        outputPath,
        legacyOutputPath,
        resolveSourceTagCommit,
      }),
      /requires macOS 99\.0, above release floor/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("launcher packaging rejects partial matrices except the narrow local test seam", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-package-ready-test-"));
  try {
    addArtifact(work, "linux", "x64", "partial-launcher");
    // Rewrite as the clean gate's explicitly non-public profile.
    const metaName = readdirSync(work).find((name) => name.endsWith(".meta.json"));
    const metaPath = join(work, metaName);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.artifactProfile = "clean-local";
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const manifestPath = join(work, "manifest.json");
    await generateManifest({
      tag,
      artifactsDir: work,
      baseUrl: `https://example.invalid/${tag}`,
      allowPartial: true,
      outputPath: manifestPath,
    });
    assert.throws(
      () => validateLauncherManifest({ manifestPath }),
      /public launcher manifest must use the release artifact profile/,
    );
    const manifest = validateLauncherManifest({
      manifestPath,
      allowTestPartial: true,
    });
    assert.equal(manifest.artifacts.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation rejects sidecars detached from the checkout", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-binding-test-"));
  try {
    const { artifact, meta } = addArtifact(work, "linux", "x64", "binding");
    meta.sourceCommit = "f".repeat(40);
    writeFileSync(
      join(work, `${artifact}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "manifest.json"),
      }),
      /source commit .* does not match checkout\/toolchain/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation rejects tampering of every release-bound sidecar field", async () => {
  const cases = [
    ["runtimeVersion", (meta) => { meta.runtimeVersion = "0.0.0"; }, /runtime version/],
    ["sourceCommit", (meta) => { meta.sourceCommit = "f".repeat(40); }, /source commit/],
    ["sourceDateEpoch", (meta) => { meta.sourceDateEpoch += 1; }, /source date epoch/],
    ["buildTime", (meta) => { meta.buildTime = "2000-01-01T00:00:00.000Z"; }, /buildTime/],
    ["lockfileSha256", (meta) => { meta.lockfileSha256 = "e".repeat(64); }, /lockfile sha256/],
    ["nodeVersion", (meta) => { meta.nodeVersion = "v24.18.1"; }, /Node version/],
    ["nodeMajor", (meta) => { meta.nodeMajor = releaseToolchain.nodeMajor + 1; }, /Node major/],
    ["nodeModuleAbi", (meta) => { meta.nodeModuleAbi = "999"; }, /native module ABI/],
    ["nodeApiVersion", (meta) => { meta.nodeApiVersion = "999"; }, /Node-API version/],
    ["npmVersion", (meta) => { meta.npmVersion = "11.16.0"; }, /npm version/],
    ["artifact", (meta) => { meta.artifact = "not-the-sidecar.tar.gz"; }, /sidecar name/],
    ["artifactProfile", (meta) => { meta.artifactProfile = "unknown"; }, /artifact profile/],
    ["bytes", (meta) => { meta.bytes += 1; }, /byte count mismatch/],
    ["sha256", (meta) => { meta.sha256 = "0".repeat(64); }, /sha256 mismatch/],
    ["bins", (meta) => { meta.bins.agenc = "../../escape"; }, /invalid agenc entrypoint/],
    ["dependencyTreeSha256", (meta) => { meta.dependencyTreeSha256 = "bad"; }, /dependency tree sha256/],
    ["dependencyPackages", (meta) => { meta.dependencyPackages = 0; }, /dependency package count/],
    ["archiveFormat", (meta) => { meta.archiveFormat = "bad\nformat"; }, /archive format/],
    ["archiveValidation", (meta) => { meta.archiveValidation.entries += 1; }, /archive validation evidence/],
    ["nativeToolchain", (meta) => { meta.nativeToolchain.builder = ""; }, /native toolchain builder/],
    ["nodeDistribution", (meta) => { meta.nativeToolchain.nodeDistributionSha256 = "0".repeat(64); }, /Node distribution evidence/],
    ["nodeHeaders", (meta) => { meta.nativeToolchain.nodeHeadersSha256 = "0".repeat(64); }, /Node headers evidence/],
    ["npmDistribution", (meta) => { meta.nativeToolchain.npmDistributionSha256 = "0".repeat(64); }, /npm distribution evidence/],
    ["rpmContentInventory", (meta) => {
      meta.nativeToolchain.rpmContentInventorySha256 = "0".repeat(64);
    }, /signed RPM content inventory does not match/],
    ["rpmSigner", (meta) => {
      meta.nativeToolchain.rpmSigningKeyIds = ["0".repeat(16)];
    }, /RPM signer set does not match/],
    ["rpmPackages", (meta) => { meta.nativeToolchain.rpmPackages.pop(); }, /RPM package set does not match/],
    ["rpmBuilder", (meta) => { meta.nativeToolchain.builder = "detached-builder"; }, /builder identity is detached/],
    ["linuxCompatibility", (meta) => { meta.minimumGlibcVersion = "bad"; }, /minimum glibc version/],
    ["libcFamily", (meta) => { meta.libcFamily = "musl"; }, /libc family/],
  ];
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-field-binding-"));
  try {
    for (const [label, mutate, expected] of cases) {
      const directory = join(work, label);
      mkdirSync(directory);
      const { artifact, meta } = addArtifact(directory, "linux", "x64", label);
      mutate(meta);
      writeFileSync(
        join(directory, `${artifact}.meta.json`),
        `${JSON.stringify(meta, null, 2)}\n`,
      );
      await assert.rejects(
        generateManifest({
          tag,
          artifactsDir: directory,
          baseUrl: `https://example.invalid/${tag}`,
          allowPartial: true,
          outputPath: join(directory, "manifest.json"),
        }),
        expected,
        label,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation rejects detached macOS and Windows toolchain evidence", async () => {
  const cases = [
    ["darwin", "arm64", "runner-label", (meta) => { meta.nativeToolchain.runnerLabel = "macos-latest"; }, /runnerLabel does not match/],
    ["darwin", "x64", "runner-image", (meta) => { meta.nativeToolchain.runnerImage = "macos99"; }, /runnerImage does not match/],
    ["darwin", "arm64", "runner-version", (meta) => { meta.nativeToolchain.runnerImageVersion = "20260714.1"; }, /runnerImageVersion does not match/],
    ["darwin", "x64", "runner-arch", (meta) => { meta.nativeToolchain.runnerArch = "ARM64"; }, /runnerArch does not match/],
    ["darwin", "x64", "xcode", (meta) => { meta.nativeToolchain.xcode = "Xcode 16.3\nBuild version 16E140"; }, /Xcode does not match/],
    ["darwin", "arm64", "sdk", (meta) => { meta.nativeToolchain.sdk = "15.4"; }, /macOS SDK does not match/],
    ["darwin", "x64", "clang", (meta) => { meta.nativeToolchain.cc = "Apple clang version 16.0.0"; }, /C compiler does not match/],
    ["win", "x64", "visual-studio", (meta) => { meta.nativeToolchain.visualStudioVersion = "17.14.0.0"; }, /Visual Studio does not match/],
    ["win", "x64", "visual-studio-path", (meta) => { meta.nativeToolchain.visualStudioInstallPath = "C:\\detached"; }, /Visual Studio path does not match/],
    ["win", "x64", "msvc-version", (meta) => { meta.nativeToolchain.msvcToolsVersion = "14.44.00000"; }, /MSVC tools does not match/],
    ["win", "x64", "sdk-version", (meta) => { meta.nativeToolchain.windowsSdkVersion = "10.0.22621.0"; }, /Windows SDK does not match/],
    ["win", "x64", "compiler-version", (meta) => { meta.nativeToolchain.cc = "Microsoft (R) C/C++ Optimizing Compiler Version 19.43 for x64"; }, /C compiler does not match/],
    ["win", "x64", "compiler-details", (meta) => { meta.nativeToolchain.compilerDetails = ""; }, /compilerDetails/],
    ["win", "x64", "compiler-hash", (meta) => { meta.nativeToolchain.msvcCompilerSha256 = "0"; }, /msvcCompilerSha256/],
    ["win", "x64", "linker-hash", (meta) => { meta.nativeToolchain.msvcLinkerSha256 = "0"; }, /msvcLinkerSha256/],
    ["win", "x64", "node-import-library", (meta) => {
      meta.nativeToolchain.nodeImportLibrarySha256 = "0".repeat(64);
    }, /Node import library evidence/],
    ["win", "x64", "node-import-library-file", (meta) => {
      meta.nativeToolchain.nodeImportLibraryFile = "detached.lib";
    }, /Node import library evidence/],
    ["win", "x64", "node-import-library-bytes", (meta) => {
      meta.nativeToolchain.nodeImportLibraryBytes += 1;
    }, /Node import library evidence/],
    ["win", "x64", "common-gypi-file", (meta) => {
      meta.nativeToolchain.nodeCommonGypiFile = "include/node/detached.gypi";
    }, /sanitized Node common\.gypi evidence/],
    ["win", "x64", "common-gypi-source", (meta) => {
      meta.nativeToolchain.nodeCommonGypiSourceSha256 = "0".repeat(64);
    }, /sanitized Node common\.gypi evidence/],
    ["win", "x64", "common-gypi-release", (meta) => {
      meta.nativeToolchain.nodeCommonGypiReleaseSha256 = "0".repeat(64);
    }, /sanitized Node common\.gypi evidence/],
    ["win", "x64", "common-gypi-transformation", (meta) => {
      meta.nativeToolchain.nodeCommonGypiTransformation = "detached-transformation";
    }, /sanitized Node common\.gypi evidence/],
  ];
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-native-toolchain-binding-"));
  try {
    for (const [platform, arch, label, mutate, expected] of cases) {
      const directory = join(work, label);
      mkdirSync(directory);
      const { artifact, meta } = addArtifact(directory, platform, arch, label);
      mutate(meta);
      writeFileSync(
        join(directory, `${artifact}.meta.json`),
        `${JSON.stringify(meta, null, 2)}\n`,
      );
      await assert.rejects(
        generateManifest({
          tag,
          artifactsDir: directory,
          baseUrl: `https://example.invalid/${tag}`,
          allowPartial: true,
          outputPath: join(directory, "manifest.json"),
        }),
        expected,
        label,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation rejects partial release matrices and tampered artifacts", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-negative-test-"));
  try {
    const { artifact } = addArtifact(work, "linux", "x64", "original");
    await assert.rejects(
      generateManifest({ tag, artifactsDir: work, resolveSourceTagCommit }),
      /release matrix must be exactly/,
    );
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://github.com/tetsuo-ai/agenc-releases/releases/download/${tag}`,
        allowPartial: true,
        outputPath: join(work, "public-partial.json"),
      }),
      /allow-partial is restricted/,
    );
    writeFileSync(join(work, artifact), "tampered");
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "manifest.json"),
      }),
      /(byte count|sha256) mismatch/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest generation rejects signed artifacts above the launcher ceiling", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-artifact-ceiling-"));
  try {
    const { artifact, meta } = addArtifact(work, "linux", "x64", "ceiling");
    meta.bytes = 256 * 1024 * 1024 + 1;
    writeFileSync(join(work, `${artifact}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    await assert.rejects(
      generateManifest({
        tag,
        artifactsDir: work,
        baseUrl: `https://example.invalid/${tag}`,
        allowPartial: true,
        outputPath: join(work, "manifest.json"),
      }),
      /launcher ceiling/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
