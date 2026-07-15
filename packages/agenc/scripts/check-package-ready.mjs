#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LEGACY_BRIDGE_CONTRACT,
  LEGACY_MANIFEST_FILENAME,
  V2_MANIFEST_FILENAME,
} from "./gen-manifest.mjs";

const launcherDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-x64",
]);
const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_ATTESTATION_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(`launcher package is not release-ready: ${message}`);
}

function validateHostedRunnerContract(nativeToolchain, key, releaseToolchain) {
  const contract = releaseToolchain.hostedRunners?.[key];
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    fail(`${key} has no reviewed hosted runner contract`);
  }
  for (const [actualField, contractField] of [
    ["runnerLabel", "runnerLabel"],
    ["runnerImage", "imageOS"],
    ["runnerImageVersion", "imageVersion"],
    ["runnerArch", "runnerArch"],
  ]) {
    if (
      typeof contract[contractField] !== "string" ||
      nativeToolchain[actualField] !== contract[contractField]
    ) {
      fail(`${key} ${actualField} does not match the reviewed hosted runner contract`);
    }
  }
  const expectedBuilder =
    `github-hosted:${contract.runnerLabel}:${contract.imageOS}:` +
    `${contract.imageVersion}:${contract.runnerArch}`;
  if (nativeToolchain.builder !== expectedBuilder) {
    fail(`${key} builder identity is detached from the hosted runner contract`);
  }
  if (key.startsWith("darwin-")) {
    for (const [actual, expected, label] of [
      [
        nativeToolchain.xcode,
        `Xcode ${contract.xcodeVersion}\nBuild version ${contract.xcodeBuild}`,
        "Xcode",
      ],
      [nativeToolchain.sdk, contract.macosSdkVersion, "macOS SDK"],
      [nativeToolchain.cc, contract.clangVersion, "C compiler"],
      [nativeToolchain.cxx, contract.clangVersion, "C++ compiler"],
    ]) {
      if (typeof expected !== "string" || actual !== expected) {
        fail(`${key} ${label} does not match the reviewed hosted runner contract`);
      }
    }
    return;
  }
  if (key === "win-x64") {
    const expectedCompiler =
      `Microsoft (R) C/C++ Optimizing Compiler Version ` +
      `${contract.msvcCompilerVersion} for x64`;
    for (const [actual, expected, label] of [
      [nativeToolchain.visualStudioVersion, contract.visualStudioVersion, "Visual Studio"],
      [
        nativeToolchain.visualStudioInstallPath,
        contract.visualStudioInstallPath,
        "Visual Studio path",
      ],
      [nativeToolchain.msvcToolsVersion, contract.msvcToolsVersion, "MSVC tools"],
      [nativeToolchain.windowsSdkVersion, contract.windowsSdkVersion, "Windows SDK"],
      [nativeToolchain.cc, expectedCompiler, "C compiler"],
      [nativeToolchain.cxx, expectedCompiler, "C++ compiler"],
    ]) {
      if (typeof expected !== "string" || actual !== expected) {
        fail(`${key} ${label} does not match the reviewed hosted runner contract`);
      }
    }
    return;
  }
  fail(`${key} is not a supported hosted runner contract`);
}

export function validateLauncherManifest({
  launcherPackagePath = resolve(launcherDir, "package.json"),
  manifestPath = resolve(
    launcherDir,
    "generated",
    V2_MANIFEST_FILENAME,
  ),
  allowTestPartial = false,
} = {}) {
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  const manifestMetadata = lstatSync(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    fail(`manifest must be a plain file: ${manifestPath}`);
  }
  if (manifestMetadata.size > MAX_RUNTIME_MANIFEST_BYTES) {
    fail(`manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  const bundledLegacyPath = resolve(
    dirname(resolve(launcherPackagePath)),
    "generated",
    LEGACY_MANIFEST_FILENAME,
  );
  if (existsSync(bundledLegacyPath)) {
    fail(`legacy bridge must not be bundled in the launcher: ${bundledLegacyPath}`);
  }
  const launcherPackage = JSON.parse(readFileSync(launcherPackagePath, "utf8"));
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.length > MAX_RUNTIME_MANIFEST_BYTES) {
    fail(`manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const repoRoot = resolve(launcherDir, "..", "..");
  const releaseToolchain = JSON.parse(
    readFileSync(resolve(repoRoot, "release-toolchain.json"), "utf8"),
  );
  if (process.versions.node !== releaseToolchain.nodeVersion) {
    fail(
      `release verification requires Node.js ${releaseToolchain.nodeVersion}; ` +
        `found ${process.version}`,
    );
  }
  const lockfileSha256 = createHash("sha256")
    .update(readFileSync(resolve(repoRoot, "package-lock.json")))
    .digest("hex");
  const sourceCommitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const gitSourceCommit = sourceCommitResult.status === 0
    ? sourceCommitResult.stdout.trim()
    : undefined;
  const explicitSourceCommit = process.env.AGENC_BUILD_COMMIT?.trim();
  if (
    gitSourceCommit !== undefined &&
    explicitSourceCommit !== undefined &&
    gitSourceCommit !== explicitSourceCommit
  ) {
    fail("AGENC_BUILD_COMMIT does not match the current Git checkout");
  }
  const sourceCommit = explicitSourceCommit ?? gitSourceCommit;
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit ?? "")) {
    fail("could not bind launcher manifest to the current Git checkout");
  }
  const sourceEpochResult = spawnSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const gitSourceEpoch = sourceEpochResult.status === 0
    ? sourceEpochResult.stdout.trim()
    : undefined;
  const explicitSourceEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if (
    gitSourceEpoch !== undefined &&
    explicitSourceEpoch !== undefined &&
    gitSourceEpoch !== explicitSourceEpoch
  ) {
    fail("SOURCE_DATE_EPOCH does not match the current Git checkout");
  }
  const sourceDateEpoch = Number(explicitSourceEpoch ?? gitSourceEpoch);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    fail("could not bind launcher manifest to the current Git source epoch");
  }
  const expectedBuild = {
    sourceCommit,
    sourceRef: `refs/tags/${manifest.releaseTag}`,
    sourceDateEpoch,
    lockfileSha256,
    nodeVersion: `v${releaseToolchain.nodeVersion}`,
    nodeMajor: releaseToolchain.nodeMajor,
    nodeModuleAbi: releaseToolchain.nodeModuleAbi,
    nodeApiVersion: releaseToolchain.nodeApiVersion,
    npmVersion: releaseToolchain.npmVersion,
  };
  if (manifest.manifestVersion !== 2) fail("manifestVersion must be 2");
  if (manifest.runtimeVersion !== launcherPackage.version) {
    fail(
      `manifest runtime ${manifest.runtimeVersion} does not match launcher ${launcherPackage.version}`,
    );
  }
  if (manifest.releaseTag !== `agenc-v${manifest.runtimeVersion}`) {
    fail("releaseTag does not match runtimeVersion");
  }
  if (manifest.releaseRepository !== "tetsuo-ai/agenc-releases") {
    fail("releaseRepository must be tetsuo-ai/agenc-releases");
  }
  if (manifest.runtimeVersion === LEGACY_BRIDGE_CONTRACT.runtimeVersion) {
    for (const [field, expected] of [
      ["nodeVersion", LEGACY_BRIDGE_CONTRACT.nodeVersion],
      ["nodeMajor", LEGACY_BRIDGE_CONTRACT.nodeMajor],
      ["nodeModuleAbi", LEGACY_BRIDGE_CONTRACT.nodeModuleAbi],
      ["nodeApiVersion", LEGACY_BRIDGE_CONTRACT.nodeApiVersion],
    ]) {
      if (manifest.build?.[field] !== expected) {
        fail(`v0.6.2 compatibility bridge requires build.${field} ${expected}`);
      }
    }
  }
  for (const [field, expected] of Object.entries(expectedBuild)) {
    if (manifest.build?.[field] !== expected) {
      fail(`manifest build.${field} does not match the checkout/release toolchain`);
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("manifest has no runtime artifacts");
  }
  if (manifest.build?.artifactProfile !== (allowTestPartial ? "clean-local" : "release")) {
    fail(
      allowTestPartial
        ? "test partial manifest must use the clean-local artifact profile"
        : "public launcher manifest must use the release artifact profile",
    );
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    const key = `${artifact.platform}-${artifact.arch}`;
    if (!/^(linux-(x64|arm64)|darwin-(x64|arm64)|win-x64)$/.test(key)) {
      fail(`unsupported platform entry ${key}`);
    }
    if (seen.has(key)) fail(`duplicate platform entry ${key}`);
    seen.add(key);
    if (artifact.runtimeVersion !== manifest.runtimeVersion) {
      fail(`${key} runtimeVersion does not match manifest`);
    }
    if (!Number.isSafeInteger(artifact.nodeMajor) || artifact.nodeMajor < 1) {
      fail(`${key} has an invalid Node major`);
    }
    for (const [field, expected] of [
      ["nodeMajor", releaseToolchain.nodeMajor],
      ["nodeModuleAbi", releaseToolchain.nodeModuleAbi],
      ["nodeApiVersion", releaseToolchain.nodeApiVersion],
    ]) {
      if (artifact[field] !== expected) fail(`${key} ${field} does not match release-toolchain.json`);
    }
    if (artifact.platform === "linux") {
      if (artifact.libcFamily !== "glibc") fail(`${key} must declare glibc`);
      for (const [field, label] of [
        ["minimumGlibcVersion", "glibc"],
        ["minimumGlibcxxVersion", "GLIBCXX"],
        ["minimumCxxAbiVersion", "CXXABI"],
      ]) {
        if (!/^\d+\.\d+(?:\.\d+)?$/.test(artifact[field] ?? "")) {
          fail(`${key} has an invalid minimum ${label} version`);
        }
      }
    } else if (
      artifact.platform === "darwin" &&
      !/^\d+\.\d+(?:\.\d+)?$/.test(artifact.minimumMacosVersion ?? "")
    ) {
      fail(`${key} has an invalid minimum macOS version`);
    }
    if (!/^[0-9]+$/.test(artifact.nodeModuleAbi ?? "")) {
      fail(`${key} has an invalid native module ABI`);
    }
    if (!/^[0-9]+$/.test(artifact.nodeApiVersion ?? "")) {
      fail(`${key} has an invalid Node-API version`);
    }
    if (typeof artifact.url !== "string" || !/^https:\/\//.test(artifact.url)) {
      fail(`${key} URL must use HTTPS`);
    }
    const artifactName =
      `agenc-runtime-${manifest.runtimeVersion}-${key}-node${artifact.nodeMajor}` +
      `-abi${artifact.nodeModuleAbi}.tar.gz`;
    const expectedUrl =
      `https://github.com/${manifest.releaseRepository}/releases/download/` +
      `${manifest.releaseTag}/${artifactName}`;
    if (!allowTestPartial && artifact.url !== expectedUrl) {
      fail(`${key} URL is not the canonical immutable release asset URL`);
    }
    if (
      !allowTestPartial &&
      (
        artifact.attestationUrl !== `${expectedUrl}.sigstore.json` ||
        !/^[0-9a-f]{64}$/.test(artifact.attestationSha256 ?? "") ||
        !Number.isSafeInteger(artifact.attestationBytes) ||
        artifact.attestationBytes <= 0 ||
        artifact.attestationBytes > MAX_RUNTIME_ATTESTATION_BYTES
      )
    ) {
      fail(`${key} has an invalid canonical Sigstore attestation identity`);
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")) {
      fail(`${key} has an invalid sha256`);
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.metadataSha256 ?? "")) {
      fail(`${key} has an invalid provenance sidecar sha256`);
    }
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > MAX_RUNTIME_ARTIFACT_BYTES
    ) {
      fail(`${key} has an invalid byte count`);
    }
    if (
      artifact.nativeToolchain === null ||
      typeof artifact.nativeToolchain !== "object" ||
      Array.isArray(artifact.nativeToolchain) ||
      artifact.nativeToolchain.schemaVersion !== 1 ||
      typeof artifact.nativeToolchain.builder !== "string" ||
      typeof artifact.nativeToolchain.cc !== "string" ||
      typeof artifact.nativeToolchain.cxx !== "string" ||
      typeof artifact.nativeToolchain.python !== "string" ||
      (artifact.platform !== "win" && typeof artifact.nativeToolchain.make !== "string")
    ) {
      fail(`${key} has invalid native toolchain metadata`);
    }
    if (!allowTestPartial) {
      const expectedDistribution = releaseToolchain.nodeDistributions?.[key];
      if (
        artifact.nativeToolchain.nodeDistributionFile !== expectedDistribution?.file ||
        artifact.nativeToolchain.nodeDistributionSha256 !== expectedDistribution?.sha256 ||
        artifact.nativeToolchain.nodeHeadersFile !== releaseToolchain.nodeHeaders?.file ||
        artifact.nativeToolchain.nodeHeadersSha256 !== releaseToolchain.nodeHeaders?.sha256 ||
        artifact.nativeToolchain.npmDistributionFile !== releaseToolchain.npmDistribution?.file ||
        artifact.nativeToolchain.npmDistributionSha256 !== releaseToolchain.npmDistribution?.sha256
      ) {
        fail(`${key} Node distribution/header evidence does not match release-toolchain.json`);
      }
      if (
        artifact.platform !== "linux" &&
        (typeof artifact.nativeToolchain.runnerImage !== "string" ||
          typeof artifact.nativeToolchain.runnerImageVersion !== "string")
      ) {
        fail(`${key} hosted runner identity is missing`);
      }
      if (
        artifact.platform === "darwin" &&
        (typeof artifact.nativeToolchain.xcode !== "string" ||
          typeof artifact.nativeToolchain.sdk !== "string")
      ) {
        fail(`${key} Xcode/SDK inventory is missing`);
      }
      if (
        artifact.platform === "win" &&
        (typeof artifact.nativeToolchain.msvcToolsVersion !== "string" ||
          typeof artifact.nativeToolchain.windowsSdkVersion !== "string" ||
          typeof artifact.nativeToolchain.compilerDetails !== "string" ||
          !/^[0-9a-f]{64}$/.test(artifact.nativeToolchain.msvcCompilerSha256 ?? "") ||
          !/^[0-9a-f]{64}$/.test(artifact.nativeToolchain.msvcLinkerSha256 ?? ""))
      ) {
        fail(`${key} MSVC/Windows SDK inventory is missing`);
      }
      if (artifact.platform !== "linux") {
        validateHostedRunnerContract(artifact.nativeToolchain, key, releaseToolchain);
      }
    }
    if (
      !allowTestPartial && artifact.platform === "linux" &&
      (!Number.isSafeInteger(
        artifact.nativeToolchain.rpmContentInventorySchemaVersion,
      ) ||
        typeof artifact.nativeToolchain.rpmContentInventoryFormat !== "string" ||
        !/^[0-9a-f]{64}$/.test(
          artifact.nativeToolchain.rpmContentInventorySha256 ?? "",
        ) ||
        !Array.isArray(artifact.nativeToolchain.rpmSigningKeyIds) ||
        artifact.nativeToolchain.rpmSigningKeyIds.length === 0 ||
        artifact.nativeToolchain.rpmSigningKeyIds.some(
          (entry) => !/^[0-9a-f]{16}$/.test(entry),
        ) ||
        !Array.isArray(artifact.nativeToolchain.rpmPackages) ||
        artifact.nativeToolchain.rpmPackages.length === 0)
    ) {
      fail(`${key} has invalid release RPM inventory metadata`);
    }
    if (!allowTestPartial && artifact.platform === "linux") {
      const inventoryContract = releaseToolchain.linux.rpmContentInventory;
      const expectedInventory = inventoryContract?.sha256?.[artifact.arch];
      const expectedPackages = Object.values(releaseToolchain.linux.builderPackages).sort();
      const actualPackages = [...artifact.nativeToolchain.rpmPackages].sort();
      const expectedSigners = [...(inventoryContract?.signatureKeyIds ?? [])].sort();
      const actualSigners = [...artifact.nativeToolchain.rpmSigningKeyIds].sort();
      if (
        artifact.nativeToolchain.rpmContentInventorySchemaVersion !==
          inventoryContract?.schemaVersion ||
        artifact.nativeToolchain.rpmContentInventoryFormat !== inventoryContract?.format ||
        artifact.nativeToolchain.rpmContentInventorySha256 !== expectedInventory ||
        JSON.stringify(actualSigners) !== JSON.stringify(expectedSigners) ||
        JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages) ||
        artifact.nativeToolchain.builder !==
          `${releaseToolchain.linux.containerImage}+rpm-content-sha256:${expectedInventory}`
      ) {
        fail(`${key} release RPM evidence does not match release-toolchain.json`);
      }
    }
    if (
      !/^[0-9a-f]{64}$/.test(artifact.dependencyTreeSha256 ?? "") ||
      !Number.isSafeInteger(artifact.dependencyPackages) ||
      artifact.dependencyPackages <= 0 ||
      typeof artifact.archiveFormat !== "string" ||
      artifact.archiveFormat.length === 0 ||
      artifact.archiveValidation?.policy !== "agenc-runtime-archive-v1" ||
      !Number.isSafeInteger(artifact.archiveValidation?.entries) ||
      artifact.archiveValidation.entries <= 0 ||
      !Number.isSafeInteger(artifact.archiveValidation?.uncompressedBytes) ||
      artifact.archiveValidation.uncompressedBytes <= 0
    ) {
      fail(`${key} has invalid dependency/archive evidence`);
    }
    if (artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc") {
      fail(`${key} has an invalid agenc entrypoint`);
    }
  }
  const actualPlatforms = [...seen].sort();
  if (allowTestPartial) {
    if (!manifest.artifacts.every((artifact) => {
      try {
        return new URL(artifact.url).hostname.endsWith(".invalid");
      } catch {
        return false;
      }
    })) {
      fail("test partial manifests may only reference .invalid URLs");
    }
  } else if (JSON.stringify(actualPlatforms) !== JSON.stringify(SUPPORTED_PLATFORMS)) {
    fail(
      `platform matrix must be exactly ${SUPPORTED_PLATFORMS.join(", ")}; got ${actualPlatforms.join(", ")}`,
    );
  }
  return manifest;
}

async function main() {
  const manifest = validateLauncherManifest();
  process.stdout.write(
    `[launcher package] verified ${manifest.artifacts.length} runtime artifact(s)\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
