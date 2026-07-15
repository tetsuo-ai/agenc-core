#!/usr/bin/env node

// Assemble the ABI-aware v2 launcher manifest plus the fixed-name v1 bridge
// consumed by launchers published before v0.6.2. Release mode requires the
// complete supported matrix; --allow-partial exists only for local checks.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRuntimeArchive } from "../lib/runtime-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolve(__dirname, "..");
const repoRoot = resolve(launcherDir, "..", "..");
export const V2_MANIFEST_FILENAME = "agenc-runtime-manifest-v2.json";
export const LEGACY_MANIFEST_FILENAME = "agenc-runtime-manifest.json";
export const LEGACY_BRIDGE_CONTRACT = Object.freeze({
  runtimeVersion: "0.6.2",
  releaseRepository: "tetsuo-ai/agenc-releases",
  releaseTag: "agenc-v0.6.2",
  nodeVersion: "v25.9.0",
  nodeMajor: 25,
  nodeModuleAbi: "141",
  nodeApiVersion: "10",
});
const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
const MAX_ATTESTATION_BUNDLE_BYTES = 4 * 1024 * 1024;
const SUPPORTED_PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-x64",
]);

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactPlatformMatrix(artifacts, label) {
  if (!Array.isArray(artifacts) || artifacts.length !== SUPPORTED_PLATFORMS.length) {
    throw new Error(`${label} must contain exactly ${SUPPORTED_PLATFORMS.length} artifacts`);
  }
  const seen = new Set();
  for (const artifact of artifacts) {
    const key = `${artifact?.platform}-${artifact?.arch}`;
    if (!SUPPORTED_PLATFORMS.includes(key)) {
      throw new Error(`${label} contains unsupported platform ${key}`);
    }
    if (seen.has(key)) throw new Error(`${label} contains duplicate platform ${key}`);
    seen.add(key);
  }
  const actual = [...seen].sort(utf8Compare);
  if (JSON.stringify(actual) !== JSON.stringify(SUPPORTED_PLATFORMS)) {
    throw new Error(`${label} platform matrix is incomplete`);
  }
}

function requireExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const actual = Object.keys(value).sort(utf8Compare);
  const wanted = [...expected].sort(utf8Compare);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields are not the exact legacy v1 schema`);
  }
}

function assertBridgeV2Manifest(manifest) {
  const bridge = LEGACY_BRIDGE_CONTRACT;
  for (const [field, expected] of [
    ["runtimeVersion", bridge.runtimeVersion],
    ["releaseRepository", bridge.releaseRepository],
    ["releaseTag", bridge.releaseTag],
  ]) {
    if (manifest?.[field] !== expected) {
      throw new Error(`legacy bridge requires ${field} ${expected}`);
    }
  }
  if (manifest.manifestVersion !== 2) {
    throw new Error("legacy bridge source must be a v2 manifest");
  }
  for (const [field, expected] of [
    ["nodeVersion", bridge.nodeVersion],
    ["nodeMajor", bridge.nodeMajor],
    ["nodeModuleAbi", bridge.nodeModuleAbi],
    ["nodeApiVersion", bridge.nodeApiVersion],
  ]) {
    if (manifest.build?.[field] !== expected) {
      throw new Error(`legacy bridge requires build.${field} ${expected}`);
    }
  }
  if (
    !/^[0-9a-f]{40,64}$/.test(manifest.build?.sourceCommit ?? "") ||
    manifest.build?.sourceRef !== `refs/tags/${bridge.releaseTag}` ||
    !Number.isSafeInteger(manifest.build?.sourceDateEpoch) ||
    !/^[0-9a-f]{64}$/.test(manifest.build?.lockfileSha256 ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(manifest.build?.npmVersion ?? "") ||
    manifest.build?.artifactProfile !== "release"
  ) {
    throw new Error("legacy bridge source provenance is incomplete");
  }
  exactPlatformMatrix(manifest.artifacts, "legacy bridge source");
  for (const artifact of manifest.artifacts) {
    const key = `${artifact.platform}-${artifact.arch}`;
    const artifactName =
      `agenc-runtime-${bridge.runtimeVersion}-${key}-node${bridge.nodeMajor}` +
      `-abi${bridge.nodeModuleAbi}.tar.gz`;
    const expectedUrl =
      `https://github.com/${bridge.releaseRepository}/releases/download/` +
      `${bridge.releaseTag}/${artifactName}`;
    if (
      artifact.runtimeVersion !== bridge.runtimeVersion ||
      artifact.nodeMajor !== bridge.nodeMajor ||
      artifact.nodeModuleAbi !== bridge.nodeModuleAbi ||
      artifact.nodeApiVersion !== bridge.nodeApiVersion ||
      artifact.url !== expectedUrl ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > MAX_RUNTIME_ARTIFACT_BYTES ||
      artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc" ||
      artifact.nativeToolchain === null ||
      typeof artifact.nativeToolchain !== "object" ||
      !/^[0-9a-f]{64}$/.test(artifact.metadataSha256 ?? "") ||
      artifact.attestationUrl !== `${artifact.url}.sigstore.json` ||
      !/^[0-9a-f]{64}$/.test(artifact.attestationSha256 ?? "") ||
      !Number.isSafeInteger(artifact.attestationBytes) ||
      artifact.attestationBytes <= 0 ||
      artifact.attestationBytes > MAX_ATTESTATION_BUNDLE_BYTES
    ) {
      throw new Error(`legacy bridge source artifact is invalid: ${key}`);
    }
  }
  return manifest;
}

export function projectLegacyManifest(v2Manifest) {
  const manifest = assertBridgeV2Manifest(v2Manifest);
  return {
    manifestVersion: 1,
    runtimeVersion: LEGACY_BRIDGE_CONTRACT.runtimeVersion,
    releaseRepository: LEGACY_BRIDGE_CONTRACT.releaseRepository,
    releaseTag: LEGACY_BRIDGE_CONTRACT.releaseTag,
    artifacts: [...manifest.artifacts]
      .sort((left, right) =>
        utf8Compare(`${left.platform}-${left.arch}`, `${right.platform}-${right.arch}`),
      )
      .map((artifact) => ({
        platform: artifact.platform,
        arch: artifact.arch,
        runtimeVersion: artifact.runtimeVersion,
        url: artifact.url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        bins: { agenc: artifact.bins.agenc },
      })),
  };
}

export function validateLegacyBridgeManifest(manifest) {
  const bridge = LEGACY_BRIDGE_CONTRACT;
  requireExactKeys(
    manifest,
    ["manifestVersion", "runtimeVersion", "releaseRepository", "releaseTag", "artifacts"],
    "frozen legacy manifest",
  );
  if (
    manifest?.manifestVersion !== 1 ||
    manifest.runtimeVersion !== bridge.runtimeVersion ||
    manifest.releaseRepository !== bridge.releaseRepository ||
    manifest.releaseTag !== bridge.releaseTag
  ) {
    throw new Error("frozen legacy manifest is not the v0.6.2 bridge");
  }
  exactPlatformMatrix(manifest.artifacts, "frozen legacy manifest");
  const orderedPlatforms = manifest.artifacts.map(
    (artifact) => `${artifact.platform}-${artifact.arch}`,
  );
  if (JSON.stringify(orderedPlatforms) !== JSON.stringify(SUPPORTED_PLATFORMS)) {
    throw new Error("frozen legacy manifest artifacts are not canonically ordered");
  }
  for (const artifact of manifest.artifacts) {
    const key = `${artifact.platform}-${artifact.arch}`;
    requireExactKeys(
      artifact,
      ["platform", "arch", "runtimeVersion", "url", "sha256", "bytes", "bins"],
      `frozen legacy manifest artifact ${key}`,
    );
    requireExactKeys(artifact.bins, ["agenc"], `frozen legacy manifest artifact ${key} bins`);
    const expectedUrl =
      `https://github.com/${bridge.releaseRepository}/releases/download/${bridge.releaseTag}/` +
      `agenc-runtime-${bridge.runtimeVersion}-${key}-node${bridge.nodeMajor}` +
      `-abi${bridge.nodeModuleAbi}.tar.gz`;
    if (
      artifact.runtimeVersion !== bridge.runtimeVersion ||
      artifact.url !== expectedUrl ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > MAX_RUNTIME_ARTIFACT_BYTES ||
      artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc"
    ) {
      throw new Error(`frozen legacy manifest artifact is invalid: ${key}`);
    }
  }
  return manifest;
}

export function frozenLegacyManifestBytes({
  path,
  sha256,
  bytes,
}) {
  requireString(sha256, "frozen legacy manifest sha256", /^[0-9a-f]{64}$/);
  requireSafeInteger(bytes, "frozen legacy manifest byte count", 1);
  if (bytes > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new Error(`frozen legacy manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  if (!existsSync(path)) {
    throw new Error(`frozen legacy manifest must be a plain file: ${path}`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`frozen legacy manifest must be a plain file: ${path}`);
  }
  if (metadata.size !== bytes) {
    throw new Error("frozen legacy manifest does not match its pinned byte identity");
  }
  const source = readFileSync(path);
  if (source.length > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new Error(`frozen legacy manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  if (source.length !== bytes || sha256Bytes(source) !== sha256) {
    throw new Error("frozen legacy manifest does not match its pinned byte identity");
  }
  let parsed;
  try { parsed = JSON.parse(source.toString("utf8")); }
  catch (error) { throw new Error("frozen legacy manifest is invalid JSON", { cause: error }); }
  validateLegacyBridgeManifest(parsed);
  if (!source.equals(Buffer.from(canonicalJson(parsed)))) {
    throw new Error("frozen legacy manifest bytes are not canonical");
  }
  return source;
}

export function reviewedLegacyBridgeIdentity(toolchain) {
  const identity = toolchain?.legacyBridge;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("release-toolchain.json has no reviewed legacy bridge identity");
  }
  requireExactKeys(
    identity,
    [
      "schemaVersion",
      "runtimeVersion",
      "releaseRepository",
      "releaseTag",
      "filename",
      "status",
      "sha256",
      "bytes",
    ],
    "reviewed legacy bridge identity",
  );
  if (
    identity.schemaVersion !== 1 ||
    identity.runtimeVersion !== LEGACY_BRIDGE_CONTRACT.runtimeVersion ||
    identity.releaseRepository !== LEGACY_BRIDGE_CONTRACT.releaseRepository ||
    identity.releaseTag !== LEGACY_BRIDGE_CONTRACT.releaseTag ||
    identity.filename !== LEGACY_MANIFEST_FILENAME
  ) {
    throw new Error("release-toolchain.json legacy bridge contract is invalid");
  }
  if (
    identity.status !== "pinned" ||
    !/^[0-9a-f]{64}$/.test(identity.sha256 ?? "") ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes <= 0 ||
    identity.bytes > MAX_RUNTIME_MANIFEST_BYTES
  ) {
    throw new Error(
      "the v0.6.2 legacy bridge must be pinned in release-toolchain.json after immutable publication",
    );
  }
  return Object.freeze({ sha256: identity.sha256, bytes: identity.bytes });
}

function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    hash.on("error", reject);
    hash.on("finish", () => resolveHash(hash.digest("hex")));
    pipeline(stream, hash).catch(reject);
  });
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveGitTagCommit(tag) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`release source tag refs/tags/${tag} is missing or does not resolve to a commit`);
  }
  return result.stdout.trim();
}

function packageVersion(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`package version missing: ${path}`);
  }
  return manifest.version;
}

function argument(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function compareStableVersions(left, right) {
  if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) {
    throw new Error("stable release version is invalid");
  }
  return compareDottedVersions(left, right);
}

function sameValue(metas, field) {
  const values = [...new Set(metas.map((meta) => meta[field]))];
  if (values.length !== 1) {
    throw new Error(`mixed ${field} values: ${values.join(", ")}`);
  }
  return values[0];
}

function expectedBuildContract() {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const releaseToolchain = JSON.parse(
    readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
  );
  const npmMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(rootPackage.packageManager ?? "");
  if (npmMatch === null) {
    throw new Error("root packageManager must pin an exact npm version");
  }
  if (npmMatch[1] !== releaseToolchain.npmVersion) {
    throw new Error("root packageManager and release-toolchain npm versions differ");
  }
  const nodeRange = rootPackage.devEngines?.runtime?.version ?? "";
  const rangeMatch = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(nodeRange);
  if (rangeMatch === null || Number(rangeMatch[4]) !== Number(rangeMatch[1]) + 1) {
    throw new Error("root devEngines.runtime.version must select one Node.js major");
  }
  const assemblerNodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    assemblerNodeMajor !== Number(rangeMatch[1]) ||
    releaseToolchain.nodeMajor !== Number(rangeMatch[1]) ||
    process.versions.node !== releaseToolchain.nodeVersion
  ) {
    throw new Error(
      `manifest generation requires Node.js ${releaseToolchain.nodeVersion}; ` +
        `found ${process.version}`,
    );
  }

  const gitCommit = captureOptional("git", ["rev-parse", "HEAD"]);
  const explicitCommit = process.env.AGENC_BUILD_COMMIT?.trim();
  if (explicitCommit && gitCommit && explicitCommit !== gitCommit) {
    throw new Error(`AGENC_BUILD_COMMIT ${explicitCommit} does not match checkout ${gitCommit}`);
  }
  const sourceCommit = explicitCommit || gitCommit;
  requireString(sourceCommit, "expected source commit", /^[0-9a-f]{40,64}$/);

  const gitEpoch = captureOptional("git", ["show", "-s", "--format=%ct", "HEAD"]);
  const explicitEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if (explicitEpoch && gitEpoch && explicitEpoch !== gitEpoch) {
    throw new Error(`SOURCE_DATE_EPOCH ${explicitEpoch} does not match checkout ${gitEpoch}`);
  }
  const epochText = explicitEpoch || gitEpoch;
  if (typeof epochText !== "string" || !/^(0|[1-9][0-9]*)$/.test(epochText)) {
    throw new Error("expected source date epoch is unavailable or invalid");
  }
  const sourceDateEpoch = requireSafeInteger(
    Number(epochText),
    "expected source date epoch",
  );
  return {
    sourceCommit,
    sourceDateEpoch,
    buildTime: new Date(sourceDateEpoch * 1000).toISOString(),
    lockfileSha256: sha256Bytes(readFileSync(join(repoRoot, "package-lock.json"))),
    nodeVersion: `v${releaseToolchain.nodeVersion}`,
    nodeMajor: releaseToolchain.nodeMajor,
    nodeModuleAbi: releaseToolchain.nodeModuleAbi,
    nodeApiVersion: releaseToolchain.nodeApiVersion,
    npmVersion: npmMatch[1],
    nodeDistributions: releaseToolchain.nodeDistributions,
    nodeHeaders: releaseToolchain.nodeHeaders,
    npmDistribution: releaseToolchain.npmDistribution,
    linux: releaseToolchain.linux,
    macos: releaseToolchain.macos,
    hostedRunners: releaseToolchain.hostedRunners,
  };
}

function requireExpectedBuildValue(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} ${String(actual)} does not match checkout/toolchain ${String(expected)}`);
  }
  return actual;
}

function requireNativeToolchain(value, key, artifactProfile, platform) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} native toolchain metadata is missing or invalid`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${key} native toolchain schemaVersion must be 1`);
  }
  requireString(value.builder, `${key} native toolchain builder`, /^[^\r\n]{1,512}$/);
  for (const field of ["cc", "cxx", "python", ...(platform === "win" ? [] : ["make"])]) {
    requireString(value[field], `${key} native toolchain ${field}`, /^[^\r\n]{1,1024}$/);
  }
  if (value.buildFlags === null || typeof value.buildFlags !== "object" || Array.isArray(value.buildFlags)) {
    throw new Error(`${key} native toolchain buildFlags is invalid`);
  }
  if (artifactProfile === "release" && platform === "linux") {
    requireString(
      value.rpmContentInventorySha256,
      `${key} signed RPM content inventory sha256`,
      /^[0-9a-f]{64}$/,
    );
    requireSafeInteger(
      value.rpmContentInventorySchemaVersion,
      `${key} signed RPM content inventory schema`,
      1,
    );
    requireString(
      value.rpmContentInventoryFormat,
      `${key} signed RPM content inventory format`,
      /^[a-z0-9|_-]{1,512}$/,
    );
    if (
      !Array.isArray(value.rpmSigningKeyIds) ||
      value.rpmSigningKeyIds.length === 0 ||
      value.rpmSigningKeyIds.some((entry) => !/^[0-9a-f]{16}$/.test(entry))
    ) {
      throw new Error(`${key} release RPM signer inventory is invalid`);
    }
    if (!Array.isArray(value.rpmPackages) || value.rpmPackages.length === 0 ||
        value.rpmPackages.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error(`${key} release RPM package inventory is invalid`);
    }
  }
  if (artifactProfile === "release") {
    for (const [field, label] of [
      ["nodeDistributionFile", "Node distribution file"],
      ["nodeHeadersFile", "Node headers file"],
      ["npmDistributionFile", "npm distribution file"],
    ]) {
      requireString(value[field], `${key} ${label}`, /^[A-Za-z0-9._-]{1,255}$/);
    }
    for (const [field, label] of [
      ["nodeDistributionSha256", "Node distribution sha256"],
      ["nodeHeadersSha256", "Node headers sha256"],
      ["npmDistributionSha256", "npm distribution sha256"],
    ]) {
      requireString(value[field], `${key} ${label}`, /^[0-9a-f]{64}$/);
    }
    if (platform !== "linux") {
      for (const field of [
        "runnerLabel", "runnerImage", "runnerImageVersion", "runnerArch",
      ]) {
        requireString(value[field], `${key} native toolchain ${field}`, /^[^\r\n]{1,1024}$/);
      }
    }
    if (platform === "darwin") {
      requireString(value.xcode, `${key} Xcode inventory`, /^[^\r]{1,4096}$/);
      requireString(value.sdk, `${key} SDK version`, /^[0-9]+(?:\.[0-9]+){1,3}$/);
    }
    if (platform === "win") {
      for (const field of [
        "visualStudioVersion", "visualStudioInstallPath", "msvcToolsVersion",
        "windowsSdkVersion", "compilerDetails",
      ]) {
        requireString(value[field], `${key} ${field}`, /^[^\r]{1,4096}$/);
      }
      for (const field of ["msvcCompilerSha256", "msvcLinkerSha256"]) {
        requireString(value[field], `${key} ${field}`, /^[0-9a-f]{64}$/);
      }
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function requireHostedRunnerToolchain(nativeToolchain, key, expectedBuild) {
  const contract = expectedBuild.hostedRunners?.[key];
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error(`${key} has no reviewed hosted runner contract`);
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
      throw new Error(
        `${key} ${actualField} does not match the reviewed hosted runner contract`,
      );
    }
  }
  const expectedBuilder =
    `github-hosted:${contract.runnerLabel}:${contract.imageOS}:` +
    `${contract.imageVersion}:${contract.runnerArch}`;
  if (nativeToolchain.builder !== expectedBuilder) {
    throw new Error(`${key} builder identity is detached from the hosted runner contract`);
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
        throw new Error(`${key} ${label} does not match the reviewed hosted runner contract`);
      }
    }
  } else if (key === "win-x64") {
    const expectedCompiler =
      `Microsoft (R) C/C++ Optimizing Compiler Version ${contract.msvcCompilerVersion} for x64`;
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
        throw new Error(`${key} ${label} does not match the reviewed hosted runner contract`);
      }
    }
  } else {
    throw new Error(`${key} is not a supported hosted runner contract`);
  }
}

function collectArtifactFiles(root) {
  const files = new Map();
  const addFile = (name, path) => {
    if (files.has(name)) {
      throw new Error(`duplicate artifact filename: ${name}`);
    }
    files.set(name, path);
  };
  for (const name of readdirSync(root).sort(utf8Compare)) {
    const path = join(root, name);
    const metadata = lstatSync(path);
    if (metadata.isFile()) {
      addFile(name, path);
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`unsupported artifact entry: ${path}`);
    }
    // `gh run download` expands each workflow artifact into one directory.
    // Accept that exact layout, but no deeper trees or filename collisions.
    for (const child of readdirSync(path).sort(utf8Compare)) {
      const childPath = join(path, child);
      if (!lstatSync(childPath).isFile()) {
        throw new Error(`artifact directory contains a non-file: ${childPath}`);
      }
      addFile(child, childPath);
    }
  }
  return files;
}

export async function generateManifest({
  repo = "tetsuo-ai/agenc-releases",
  tag,
  artifactsDir = join(launcherDir, "release-artifacts"),
  baseUrl,
  allowPartial = false,
  outputPath = join(launcherDir, "generated", V2_MANIFEST_FILENAME),
  legacyOutputPath = join(launcherDir, "release-manifests", LEGACY_MANIFEST_FILENAME),
  frozenLegacyPath,
  frozenLegacySha256,
  frozenLegacyBytes,
  resolveSourceTagCommit = resolveGitTagCommit,
} = {}) {
  requireString(repo, "release repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  requireString(tag, "release tag", /^agenc-v[0-9]+\.[0-9]+\.[0-9]+$/);
  const resolvedArtifacts = resolve(artifactsDir);
  if (!existsSync(resolvedArtifacts) || !lstatSync(resolvedArtifacts).isDirectory()) {
    throw new Error(`artifacts directory not found: ${resolvedArtifacts}`);
  }

  const rootVersion = packageVersion(join(repoRoot, "package.json"));
  const runtimeVersion = packageVersion(join(repoRoot, "runtime", "package.json"));
  const launcherVersion = packageVersion(join(launcherDir, "package.json"));
  if (rootVersion !== runtimeVersion || launcherVersion !== runtimeVersion) {
    throw new Error(
      `release versions differ (root=${rootVersion}, runtime=${runtimeVersion}, launcher=${launcherVersion})`,
    );
  }
  if (tag !== `agenc-v${runtimeVersion}`) {
    throw new Error(`tag ${tag} does not match runtime ${runtimeVersion}`);
  }
  const expectedBuild = expectedBuildContract();

  const resolvedBaseUrl =
    baseUrl ?? `https://github.com/${repo}/releases/download/${tag}`;
  const parsedBaseUrl = new URL(resolvedBaseUrl);
  if (parsedBaseUrl.protocol !== "https:") {
    throw new Error("release base URL must use HTTPS");
  }
  const localPartialProfileAllowed =
    allowPartial && parsedBaseUrl.hostname.endsWith(".invalid");
  if (allowPartial && !localPartialProfileAllowed) {
    throw new Error("--allow-partial is restricted to non-public .invalid URLs");
  }
  if (!localPartialProfileAllowed) {
    if (repo !== LEGACY_BRIDGE_CONTRACT.releaseRepository) {
      throw new Error(`public manifests must use ${LEGACY_BRIDGE_CONTRACT.releaseRepository}`);
    }
    const canonicalBaseUrl =
      `https://github.com/${repo}/releases/download/${tag}`;
    if (resolvedBaseUrl !== canonicalBaseUrl) {
      throw new Error("public manifest base URL is not the canonical immutable release URL");
    }
    const sourceTagCommit = requireString(
      resolveSourceTagCommit(tag),
      "release source tag commit",
      /^[0-9a-f]{40,64}$/,
    );
    if (sourceTagCommit !== expectedBuild.sourceCommit) {
      throw new Error(
        `release source tag ${tag} resolves to ${sourceTagCommit}, not checkout ${expectedBuild.sourceCommit}`,
      );
    }
  }

  const files = collectArtifactFiles(resolvedArtifacts);
  const names = [...files.keys()].sort(utf8Compare);
  const metaNames = names.filter((name) => name.endsWith(".meta.json"));
  if (metaNames.length === 0) {
    throw new Error(`no *.meta.json files in ${resolvedArtifacts}`);
  }
  const metas = metaNames.map((name) => {
    const path = files.get(name);
    const meta = JSON.parse(readFileSync(path, "utf8"));
    if (name !== `${meta.artifact}.meta.json`) {
      throw new Error(`sidecar name does not match artifact: ${name}`);
    }
    return meta;
  });

  const seen = new Set();
  const artifacts = [];
  for (const meta of metas) {
    const platform = requireString(meta.platform, "platform", /^(linux|darwin|win)$/);
    const arch = requireString(meta.arch, "architecture", /^(x64|arm64)$/);
    const key = `${platform}-${arch}`;
    const artifactProfile = requireString(
      meta.artifactProfile,
      `${key} artifact profile`,
      /^(release|clean-local|container-local)$/,
    );
    if (artifactProfile !== "release" && !localPartialProfileAllowed) {
      throw new Error(
        `${key} ${artifactProfile} artifact cannot be used in a public release manifest`,
      );
    }
    if (!SUPPORTED_PLATFORMS.includes(key)) {
      throw new Error(`unsupported runtime platform: ${key}`);
    }
    if (seen.has(key)) throw new Error(`duplicate runtime platform: ${key}`);
    seen.add(key);
    if (meta.runtimeVersion !== runtimeVersion) {
      throw new Error(`${key} runtime version ${meta.runtimeVersion} is not ${runtimeVersion}`);
    }
    const nodeMajor = requireSafeInteger(meta.nodeMajor, `${key} Node major`, 1);
    const nodeModuleAbi = requireString(
      meta.nodeModuleAbi,
      `${key} native module ABI`,
      /^[0-9]+$/,
    );
    const nodeApiVersion = requireString(
      meta.nodeApiVersion,
      `${key} Node-API version`,
      /^[0-9]+$/,
    );
    requireExpectedBuildValue(nodeMajor, expectedBuild.nodeMajor, `${key} Node major`);
    requireExpectedBuildValue(
      nodeModuleAbi,
      expectedBuild.nodeModuleAbi,
      `${key} native module ABI`,
    );
    requireExpectedBuildValue(
      nodeApiVersion,
      expectedBuild.nodeApiVersion,
      `${key} Node-API version`,
    );
    const artifactName = requireString(
      meta.artifact,
      `${key} artifact name`,
      new RegExp(
        `^agenc-runtime-${runtimeVersion.replaceAll(".", "\\.")}-${key}` +
          `-node${nodeMajor}-abi${nodeModuleAbi}\\.tar\\.gz$`,
      ),
    );
    const artifactPath = files.get(artifactName);
    if (artifactPath === undefined) {
      throw new Error(`${key} artifact is missing: ${artifactName}`);
    }
    const expectedBytes = requireSafeInteger(meta.bytes, `${key} byte count`, 1);
    if (expectedBytes > MAX_RUNTIME_ARTIFACT_BYTES) {
      throw new Error(
        `${key} byte count exceeds the ${MAX_RUNTIME_ARTIFACT_BYTES}-byte launcher ceiling`,
      );
    }
    const actualBytes = statSync(artifactPath).size;
    if (actualBytes !== expectedBytes) {
      throw new Error(`${key} byte count mismatch (${expectedBytes} != ${actualBytes})`);
    }
    const expectedDigest = requireString(meta.sha256, `${key} sha256`, /^[0-9a-f]{64}$/);
    const actualDigest = await sha256File(artifactPath);
    if (actualDigest !== expectedDigest) {
      throw new Error(`${key} sha256 mismatch (${expectedDigest} != ${actualDigest})`);
    }
    let attestation;
    if (artifactProfile === "release") {
      const attestationName = `${artifactName}.sigstore.json`;
      const attestationPath = files.get(attestationName);
      if (attestationPath === undefined) {
        throw new Error(`${key} canonical Sigstore bundle is missing: ${attestationName}`);
      }
      const attestationBytes = statSync(attestationPath).size;
      if (
        !Number.isSafeInteger(attestationBytes) ||
        attestationBytes <= 0 ||
        attestationBytes > MAX_ATTESTATION_BUNDLE_BYTES
      ) {
        throw new Error(`${key} canonical Sigstore bundle has an invalid byte count`);
      }
      try {
        const parsed = JSON.parse(readFileSync(attestationPath, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("bundle root is not an object");
        }
      } catch (error) {
        throw new Error(`${key} canonical Sigstore bundle is invalid JSON`, { cause: error });
      }
      attestation = {
        attestationUrl: `${resolvedBaseUrl}/${attestationName}`,
        attestationSha256: await sha256File(attestationPath),
        attestationBytes,
      };
    }
    const metadataPath = files.get(`${artifactName}.meta.json`);
    if (metadataPath === undefined) {
      throw new Error(`${key} provenance sidecar is missing`);
    }
    const metadataSha256 = await sha256File(metadataPath);
    if (meta.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc") {
      throw new Error(`${key} has an invalid agenc entrypoint`);
    }
    const nativeToolchain = requireNativeToolchain(
      meta.nativeToolchain,
      key,
      artifactProfile,
      platform,
    );
    if (artifactProfile === "release") {
      const expectedDistribution = expectedBuild.nodeDistributions?.[key];
      if (
        nativeToolchain.nodeDistributionFile !== expectedDistribution?.file ||
        nativeToolchain.nodeDistributionSha256 !== expectedDistribution?.sha256
      ) {
        throw new Error(`${key} Node distribution evidence does not match release-toolchain.json`);
      }
      if (
        nativeToolchain.nodeHeadersFile !== expectedBuild.nodeHeaders?.file ||
        nativeToolchain.nodeHeadersSha256 !== expectedBuild.nodeHeaders?.sha256
      ) {
        throw new Error(`${key} Node headers evidence does not match release-toolchain.json`);
      }
      if (
        nativeToolchain.npmDistributionFile !== expectedBuild.npmDistribution?.file ||
        nativeToolchain.npmDistributionSha256 !== expectedBuild.npmDistribution?.sha256
      ) {
        throw new Error(`${key} npm distribution evidence does not match release-toolchain.json`);
      }
      if (platform === "darwin" || platform === "win") {
        requireHostedRunnerToolchain(nativeToolchain, key, expectedBuild);
      }
    }
    const dependencyTreeSha256 = requireString(
      meta.dependencyTreeSha256,
      `${key} dependency tree sha256`,
      /^[0-9a-f]{64}$/,
    );
    const dependencyPackages = requireSafeInteger(
      meta.dependencyPackages,
      `${key} dependency package count`,
      1,
    );
    const archiveFormat = requireString(
      meta.archiveFormat,
      `${key} archive format`,
      /^[^\r\n]{1,256}$/,
    );
    const validatedArchive = validateRuntimeArchive(artifactPath, platform);
    if (
      meta.archiveValidation?.policy !== "agenc-runtime-archive-v1" ||
      meta.archiveValidation?.entries !== validatedArchive.entries ||
      meta.archiveValidation?.uncompressedBytes !== validatedArchive.uncompressedBytes
    ) {
      throw new Error(`${key} archive validation evidence does not match final artifact bytes`);
    }
    const archiveValidation = {
      policy: "agenc-runtime-archive-v1",
      entries: validatedArchive.entries,
      uncompressedBytes: validatedArchive.uncompressedBytes,
    };
    const platformCompatibility = platform === "linux"
      ? {
          libcFamily: requireString(
            meta.libcFamily,
            `${key} libc family`,
            /^glibc$/,
          ),
          minimumGlibcVersion: requireString(
            meta.minimumGlibcVersion,
            `${key} minimum glibc version`,
            /^\d+\.\d+(?:\.\d+)?$/,
          ),
          minimumGlibcxxVersion: requireString(
            meta.minimumGlibcxxVersion,
            `${key} minimum GLIBCXX version`,
            /^\d+\.\d+(?:\.\d+)?$/,
          ),
          minimumCxxAbiVersion: requireString(
            meta.minimumCxxAbiVersion,
            `${key} minimum CXXABI version`,
            /^\d+\.\d+(?:\.\d+)?$/,
          ),
        }
      : platform === "darwin"
        ? {
            minimumMacosVersion: requireString(
              meta.minimumMacosVersion,
              `${key} minimum macOS version`,
              /^\d+\.\d+(?:\.\d+)?$/,
            ),
          }
      : {};
    if (platform === "linux" && artifactProfile === "release") {
      const inventoryContract = expectedBuild.linux.rpmContentInventory;
      const expectedInventory = inventoryContract?.sha256?.[arch];
      if (
        nativeToolchain.rpmContentInventorySchemaVersion !== inventoryContract?.schemaVersion ||
        nativeToolchain.rpmContentInventoryFormat !== inventoryContract?.format ||
        nativeToolchain.rpmContentInventorySha256 !== expectedInventory
      ) {
        throw new Error(
          `${key} signed RPM content inventory does not match release-toolchain.json`,
        );
      }
      if (
        JSON.stringify([...nativeToolchain.rpmSigningKeyIds].sort(utf8Compare)) !==
        JSON.stringify([...inventoryContract.signatureKeyIds].sort(utf8Compare))
      ) {
        throw new Error(`${key} RPM signer set does not match release-toolchain.json`);
      }
      const expectedPackages = Object.values(expectedBuild.linux.builderPackages).sort(utf8Compare);
      if (
        JSON.stringify([...nativeToolchain.rpmPackages].sort(utf8Compare)) !==
        JSON.stringify(expectedPackages)
      ) {
        throw new Error(`${key} RPM package set does not match release-toolchain.json`);
      }
      const expectedBuilder =
        `${expectedBuild.linux.containerImage}+rpm-content-sha256:${expectedInventory}`;
      if (nativeToolchain.builder !== expectedBuilder) {
        throw new Error(`${key} builder identity is detached from the approved RPM inventory`);
      }
      const ceilings = [
        [platformCompatibility.minimumGlibcVersion, expectedBuild.linux.maximumGlibcVersion, "GLIBC"],
        [platformCompatibility.minimumGlibcxxVersion, expectedBuild.linux.maximumGlibcxxVersion, "GLIBCXX"],
        [platformCompatibility.minimumCxxAbiVersion, expectedBuild.linux.maximumCxxAbiVersion, "CXXABI"],
      ];
      for (const [minimum, maximum, label] of ceilings) {
        if (compareDottedVersions(minimum, maximum) > 0) {
          throw new Error(`${key} requires ${label}_${minimum}, above release ceiling ${maximum}`);
        }
      }
    } else if (
      platform === "darwin" &&
      artifactProfile === "release" &&
      compareDottedVersions(
        platformCompatibility.minimumMacosVersion,
        expectedBuild.macos.minimumVersion,
      ) > 0
    ) {
      throw new Error(
        `${key} requires macOS ${platformCompatibility.minimumMacosVersion}, ` +
          `above release floor ${expectedBuild.macos.minimumVersion}`,
      );
    }
    artifacts.push({
      platform,
      arch,
      runtimeVersion,
      nodeMajor,
      nodeModuleAbi,
      nodeApiVersion,
      url: `${resolvedBaseUrl}/${artifactName}`,
      sha256: actualDigest,
      bytes: actualBytes,
      ...attestation,
      metadataSha256,
      nativeToolchain,
      dependencyTreeSha256,
      dependencyPackages,
      archiveFormat,
      archiveValidation,
      ...platformCompatibility,
      bins: { agenc: meta.bins.agenc },
    });
  }

  const actualPlatforms = [...seen].sort(utf8Compare);
  if (!allowPartial && JSON.stringify(actualPlatforms) !== JSON.stringify(SUPPORTED_PLATFORMS)) {
    throw new Error(
      `release matrix must be exactly ${SUPPORTED_PLATFORMS.join(", ")}; got ${actualPlatforms.join(", ")}`,
    );
  }

  for (const name of names.filter((entry) => entry.endsWith(".tar.gz"))) {
    if (!metas.some((meta) => meta.artifact === name)) {
      throw new Error(`runtime artifact has no sidecar: ${name}`);
    }
  }
  for (const name of names.filter((entry) => entry.endsWith(".tar.gz.sigstore.json"))) {
    const artifactName = name.slice(0, -".sigstore.json".length);
    if (!metas.some((meta) => meta.artifact === artifactName)) {
      throw new Error(`canonical Sigstore bundle has no runtime artifact: ${name}`);
    }
  }

  const sourceCommit = requireString(
    sameValue(metas, "sourceCommit"),
    "source commit",
    /^[0-9a-f]{40,64}$/,
  );
  const artifactProfile = requireString(
    sameValue(metas, "artifactProfile"),
    "artifact profile",
    /^(release|clean-local|container-local)$/,
  );
  requireExpectedBuildValue(sourceCommit, expectedBuild.sourceCommit, "source commit");
  const sourceDateEpoch = requireSafeInteger(
    sameValue(metas, "sourceDateEpoch"),
    "source date epoch",
  );
  requireExpectedBuildValue(
    sourceDateEpoch,
    expectedBuild.sourceDateEpoch,
    "source date epoch",
  );
  const lockfileSha256 = requireString(
    sameValue(metas, "lockfileSha256"),
    "lockfile sha256",
    /^[0-9a-f]{64}$/,
  );
  requireExpectedBuildValue(
    lockfileSha256,
    expectedBuild.lockfileSha256,
    "lockfile sha256",
  );
  const nodeVersion = requireString(
    sameValue(metas, "nodeVersion"),
    "Node version",
    /^v[0-9]+\.[0-9]+\.[0-9]+$/,
  );
  requireExpectedBuildValue(nodeVersion, expectedBuild.nodeVersion, "Node version");
  const nodeMajor = requireSafeInteger(
    sameValue(metas, "nodeMajor"),
    "Node major",
    1,
  );
  requireExpectedBuildValue(nodeMajor, expectedBuild.nodeMajor, "Node major");
  if (Number(nodeVersion.slice(1).split(".")[0]) !== nodeMajor) {
    throw new Error("artifact Node version and major disagree");
  }
  const nodeModuleAbi = requireString(
    sameValue(metas, "nodeModuleAbi"),
    "native module ABI",
    /^[0-9]+$/,
  );
  requireExpectedBuildValue(
    nodeModuleAbi,
    expectedBuild.nodeModuleAbi,
    "native module ABI",
  );
  const nodeApiVersion = requireString(
    sameValue(metas, "nodeApiVersion"),
    "Node-API version",
    /^[0-9]+$/,
  );
  requireExpectedBuildValue(
    nodeApiVersion,
    expectedBuild.nodeApiVersion,
    "Node-API version",
  );
  const npmVersion = requireString(
    sameValue(metas, "npmVersion"),
    "npm version",
    /^[0-9]+\.[0-9]+\.[0-9]+$/,
  );
  requireExpectedBuildValue(npmVersion, expectedBuild.npmVersion, "npm version");
  const expectedBuildTime = new Date(sourceDateEpoch * 1000).toISOString();
  if (sameValue(metas, "buildTime") !== expectedBuildTime) {
    throw new Error("artifact buildTime does not match sourceDateEpoch");
  }
  requireExpectedBuildValue(expectedBuildTime, expectedBuild.buildTime, "build time");

  const manifest = {
    manifestVersion: 2,
    runtimeVersion,
    releaseRepository: repo,
    releaseTag: tag,
    build: {
      sourceCommit,
      sourceRef: `refs/tags/${tag}`,
      sourceDateEpoch,
      lockfileSha256,
      nodeVersion,
      nodeMajor,
      nodeModuleAbi,
      nodeApiVersion,
      npmVersion,
      artifactProfile,
    },
    artifacts: artifacts.sort((a, b) =>
      utf8Compare(`${a.platform}-${a.arch}`, `${b.platform}-${b.arch}`),
    ),
  };
  let legacyManifest;
  let legacyBytes;
  let resolvedLegacyOutputPath;
  if (!allowPartial) {
    resolvedLegacyOutputPath = resolve(legacyOutputPath);
    if (runtimeVersion === LEGACY_BRIDGE_CONTRACT.runtimeVersion) {
      if (
        frozenLegacyPath !== undefined ||
        frozenLegacySha256 !== undefined ||
        frozenLegacyBytes !== undefined
      ) {
        throw new Error("v0.6.2 must generate its legacy bridge from the reviewed v2 manifest");
      }
      legacyManifest = projectLegacyManifest(manifest);
      legacyBytes = Buffer.from(canonicalJson(legacyManifest));
    } else {
      if (compareStableVersions(runtimeVersion, LEGACY_BRIDGE_CONTRACT.runtimeVersion) < 0) {
        throw new Error(
          `legacy bridge generation is only valid at or after ` +
            `${LEGACY_BRIDGE_CONTRACT.runtimeVersion}`,
        );
      }
      if (
        frozenLegacyPath === undefined ||
        frozenLegacySha256 === undefined ||
        frozenLegacyBytes === undefined
      ) {
        throw new Error(
          "post-v0.6.2 releases must supply the exact pinned v0.6.2 legacy manifest bytes",
        );
      }
      legacyBytes = frozenLegacyManifestBytes({
        path: resolve(frozenLegacyPath),
        sha256: frozenLegacySha256,
        bytes: frozenLegacyBytes,
      });
      legacyManifest = JSON.parse(legacyBytes.toString("utf8"));
    }
    if (legacyBytes.length > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error(`legacy manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
    }
    if (resolve(outputPath) === resolvedLegacyOutputPath) {
      throw new Error("v2 and legacy manifest outputs must be different files");
    }
  }
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  if (manifestBytes.length > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new Error(`v2 manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, manifestBytes);
  // npm pack preserves source modes. Canonicalize after creation because a
  // restrictive process umask can mask writeFileSync's requested mode.
  chmodSync(outputPath, 0o644);
  if (resolvedLegacyOutputPath !== undefined) {
    mkdirSync(dirname(resolvedLegacyOutputPath), { recursive: true });
    writeFileSync(resolvedLegacyOutputPath, legacyBytes);
    chmodSync(resolvedLegacyOutputPath, 0o644);
  }
  return {
    manifest,
    outputPath,
    legacyManifest,
    legacyOutputPath: resolvedLegacyOutputPath,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const tag = argument(args, "tag");
  const repo = argument(args, "repo", "tetsuo-ai/agenc-releases");
  const artifactsDir = resolve(
    argument(args, "artifacts", join(launcherDir, "release-artifacts")),
  );
  const baseUrl = argument(args, "base-url");
  const allowPartial = args.includes("--allow-partial");
  const legacyOutputPath = resolve(argument(
    args,
    "legacy-output",
    join(launcherDir, "release-manifests", LEGACY_MANIFEST_FILENAME),
  ));
  const frozenLegacyPath = argument(args, "frozen-legacy");
  for (const forbidden of ["--frozen-legacy-sha256", "--frozen-legacy-bytes"]) {
    if (args.includes(forbidden)) {
      throw new Error(`${forbidden} is not accepted; use the reviewed release-toolchain identity`);
    }
  }
  let frozenLegacySha256;
  let frozenLegacyBytes;
  if (frozenLegacyPath !== undefined) {
    const toolchain = JSON.parse(
      readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
    );
    ({ sha256: frozenLegacySha256, bytes: frozenLegacyBytes } =
      reviewedLegacyBridgeIdentity(toolchain));
  }
  const { manifest, outputPath, legacyOutputPath: writtenLegacyPath } = await generateManifest({
    repo,
    tag,
    artifactsDir,
    baseUrl,
    allowPartial,
    legacyOutputPath,
    frozenLegacyPath,
    frozenLegacySha256,
    frozenLegacyBytes,
  });
  console.error(
    `gen-manifest: wrote ${outputPath} (${manifest.artifacts.length} platform(s): ${manifest.artifacts
      .map((artifact) => `${artifact.platform}-${artifact.arch}`)
      .join(", ")})`,
  );
  if (writtenLegacyPath !== undefined) {
    console.error(`gen-manifest: wrote legacy bridge ${writtenLegacyPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(`gen-manifest: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
