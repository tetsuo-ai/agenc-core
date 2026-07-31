#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateLauncherManifest } from "./check-package-ready.mjs";
import {
  canonicalRuntimeAttestationVerificationArgs,
  canonicalRuntimeBuildProvenanceVerificationArgs,
  MINIMUM_PRIVATE_NODE_RUNTIME_VERSION,
  PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG,
  RUNTIME_ATTESTATION_POLICY,
  RUNTIME_BUILD_PROVENANCE_POLICY,
  runtimeVersionRequiresDualProvenance,
  validateRuntimeReleaseCandidateIdentity,
} from "../lib/runtime-release-contract.mjs";
import {
  frozenLegacyManifestBytes,
  LEGACY_BRIDGE_CONTRACT,
  LEGACY_MANIFEST_FILENAME,
  projectLegacyManifest,
  reviewedLegacyBridgeIdentity,
  V2_MANIFEST_FILENAME,
} from "./gen-manifest.mjs";

const launcherDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(launcherDir, "..", "..");
const MAX_ATTESTATION_BUNDLE_BYTES = 4 * 1024 * 1024;
const DEFAULT_ATTESTATION_TIMEOUT_MS = 30_000;
export const RELEASE_ATTESTATION_POLICY = RUNTIME_ATTESTATION_POLICY;
export const RELEASE_BUILD_PROVENANCE_POLICY = RUNTIME_BUILD_PROVENANCE_POLICY;

export function canonicalAttestationVerificationArgs(subjectPath, bundlePath, manifest) {
  const sourceCommit = manifest?.build?.sourceCommit;
  const sourceRef = manifest?.build?.sourceRef;
  return canonicalRuntimeAttestationVerificationArgs({
    subjectPath,
    bundlePath,
    sourceCommit,
    sourceRef,
  });
}

export function canonicalBuildProvenanceVerificationArgs(
  subjectPath,
  bundlePath,
  manifest,
) {
  const sourceCommit = manifest?.build?.sourceCommit;
  return canonicalRuntimeBuildProvenanceVerificationArgs({
    subjectPath,
    bundlePath,
    sourceCommit,
  });
}

export function isolatedGitHubCliEnvironment(workDirectory, source = process.env) {
  const environment = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const configDirectory = join(workDirectory, "config");
  return {
    ...environment,
    HOME: workDirectory,
    USERPROFILE: workDirectory,
    APPDATA: configDirectory,
    LOCALAPPDATA: configDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_CACHE_HOME: configDirectory,
    GH_CONFIG_DIR: configDirectory,
    GH_HOST: RELEASE_ATTESTATION_POLICY.hostname,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    TEMP: workDirectory,
    TMP: workDirectory,
  };
}

function argument(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return resolve(fallback);
    throw new Error(`missing --${name}`);
  }
  if (!args[index + 1]) throw new Error(`missing value for --${name}`);
  return resolve(args[index + 1]);
}

function git(args, { binary = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: binary ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().trim() || "unknown error"}`);
  }
  return binary ? result.stdout : result.stdout.trim();
}

function collect(root) {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`release artifacts root must be a plain directory: ${root}`);
  }
  const files = new Map();
  const visit = (path, depth) => {
    if (depth > 1) throw new Error(`unexpected nested artifact directory: ${path}`);
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const metadata = lstatSync(child);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) visit(child, depth + 1);
      else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        if (files.has(name)) throw new Error(`duplicate release asset name: ${name}`);
        files.set(name, child);
      } else throw new Error(`unsupported release asset entry: ${child}`);
    }
  };
  visit(root, 0);
  return files;
}

function assertPlainFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is required: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a plain file: ${path}`);
  }
}

function assertEmptyOutput(output) {
  if (existsSync(output)) {
    const metadata = lstatSync(output);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`release output must be a plain directory: ${output}`);
    }
    if (readdirSync(output).length > 0) {
      throw new Error(`release output must be empty: ${output}`);
    }
  }
}

function assertReleaseSource(manifest, requireCleanCheckout) {
  const head = git(["rev-parse", "HEAD"]);
  if (head !== manifest.build.sourceCommit) {
    throw new Error(`release checkout ${head} does not match manifest source ${manifest.build.sourceCommit}`);
  }
  const expectedRef = `refs/tags/${manifest.releaseTag}`;
  if (manifest.build.sourceRef !== expectedRef) {
    throw new Error(`manifest source ref must be ${expectedRef}`);
  }
  const tagCommit = git(["rev-parse", "--verify", `${expectedRef}^{commit}`]);
  if (tagCommit !== manifest.build.sourceCommit) {
    throw new Error(`release tag ${expectedRef} does not resolve to the manifest source commit`);
  }
  if (requireCleanCheckout) {
    const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status !== "") throw new Error("release checkout has tracked or untracked source changes");
  }
}

function readCommittedSourceFile(commit, path) {
  return git(["show", `${commit}:${path}`], { binary: true });
}

function expectedSbomBytes(manifest, readSourceFile) {
  const work = mkdtempSync(join(tmpdir(), "agenc-release-sbom-"));
  try {
    const lockfile = join(work, "package-lock.json");
    const toolchain = join(work, "release-toolchain.json");
    const output = join(work, "agenc-core.spdx.json");
    writeFileSync(
      lockfile,
      readSourceFile(manifest.build.sourceCommit, "package-lock.json"),
      { mode: 0o600 },
    );
    writeFileSync(
      toolchain,
      readSourceFile(manifest.build.sourceCommit, "release-toolchain.json"),
      { mode: 0o600 },
    );
    const generated = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "generate-spdx-sbom.mjs"),
        "--lockfile", lockfile,
        "--toolchain", toolchain,
        "--output", output,
        "--source-commit", manifest.build.sourceCommit,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SOURCE_DATE_EPOCH: String(manifest.build.sourceDateEpoch),
        },
      },
    );
    if (generated.status !== 0) {
      throw new Error(`exact-source SBOM generation failed: ${generated.stderr || generated.stdout}`);
    }
    return readFileSync(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function exactSourceReleaseToolchain(manifest, readSourceFile) {
  const bytes = readSourceFile(manifest.build.sourceCommit, "release-toolchain.json");
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("exact-source release-toolchain.json bytes are unavailable");
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error("exact-source release-toolchain.json is invalid JSON", {
      cause: error,
    });
  }
}

const NODE_BOOTSTRAP_KEYS = Object.freeze(["linux-arm64", "linux-x64"]);

export function nodeBootstrapReleaseAssets({
  releaseToolchain,
  manifest,
  downloaded,
}) {
  const bootstrapContract = releaseToolchain?.nodeBootstrap;
  if (
    bootstrapContract === null ||
    typeof bootstrapContract !== "object" ||
    Array.isArray(bootstrapContract) ||
    bootstrapContract.schemaVersion !== 1 ||
    bootstrapContract.minimumRuntimeVersion !== MINIMUM_PRIVATE_NODE_RUNTIME_VERSION ||
    bootstrapContract.releaseTag !== PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG
  ) {
    throw new Error(
      "Node bootstrap must remain anchored to the minimum private-Node runtime release",
    );
  }

  const reviewed = [];
  for (const key of NODE_BOOTSTRAP_KEYS) {
    const bootstrap = bootstrapContract[key];
    const expectedFile = `agenc-node-bootstrap-libatomic-${key}.tar.gz`;
    if (
      bootstrap === null ||
      typeof bootstrap !== "object" ||
      Array.isArray(bootstrap) ||
      bootstrap.file !== expectedFile ||
      bootstrap.url !==
        `https://github.com/${manifest.releaseRepository}/releases/download/` +
        `${PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG}/${expectedFile}` ||
      !/^[0-9a-f]{64}$/.test(bootstrap.sha256 ?? "") ||
      !Number.isSafeInteger(bootstrap.bytes) ||
      bootstrap.bytes <= 0
    ) {
      throw new Error(`Node bootstrap asset contract is invalid for ${key}`);
    }
    reviewed.push(bootstrap);
  }

  if (manifest.releaseTag !== PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG) {
    return [];
  }
  if (manifest.runtimeVersion !== MINIMUM_PRIVATE_NODE_RUNTIME_VERSION) {
    throw new Error("Node bootstrap release tag is detached from its runtime version");
  }
  if (!(downloaded instanceof Map)) {
    throw new TypeError("downloaded Node bootstrap assets are required for the anchor release");
  }

  return reviewed.map((bootstrap) => {
    const source = downloaded.get(bootstrap.file);
    if (source === undefined) {
      throw new Error(`Node bootstrap release asset is missing: ${bootstrap.file}`);
    }
    const bytes = readFileSync(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== bootstrap.bytes || digest !== bootstrap.sha256) {
      throw new Error(
        `Node bootstrap asset identity mismatch for ${bootstrap.file}`,
      );
    }
    return [bootstrap.file, source];
  });
}

function verifyCanonicalAttestation(
  subjectPath,
  bundlePath,
  manifest,
  { githubCliPath, timeoutMs, provenanceKind = "promotion" },
) {
  assertPlainFile(bundlePath, "canonical Sigstore bundle");
  if (typeof githubCliPath !== "string" || !isAbsolute(githubCliPath)) {
    throw new Error("an absolute checksum-pinned GitHub CLI path is required");
  }
  assertPlainFile(githubCliPath, "checksum-pinned GitHub CLI");
  if (realpathSync.native(githubCliPath) !== githubCliPath) {
    throw new Error("checksum-pinned GitHub CLI path must be canonical");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("attestation timeout must be a positive safe integer");
  }
  const work = mkdtempSync(join(tmpdir(), "agenc-gh-attestation-"));
  const configDirectory = join(work, "config");
  let verify;
  try {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    verify = spawnSync(
      githubCliPath,
      provenanceKind === "build"
        ? canonicalBuildProvenanceVerificationArgs(subjectPath, bundlePath, manifest)
        : canonicalAttestationVerificationArgs(subjectPath, bundlePath, manifest),
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: isolatedGitHubCliEnvironment(work),
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (verify.error?.code === "ENOENT") {
    throw new Error("checksum-pinned GitHub CLI disappeared during attestation verification");
  }
  if (verify.error !== undefined) {
    throw new Error(`GitHub attestation verifier failed to run: ${verify.error.message}`);
  }
  if (verify.status !== 0) {
    throw new Error(
      `GitHub attestation policy rejected ${basename(subjectPath)}: ` +
      `${verify.stderr?.trim() || verify.stdout?.trim() || "unknown error"}`,
    );
  }
}

export function prepareReleaseAssets({
  artifactsRoot,
  output,
  manifestPath = join(launcherDir, "generated", V2_MANIFEST_FILENAME),
  legacyManifestPath = join(launcherDir, "release-manifests", LEGACY_MANIFEST_FILENAME),
  frozenLegacySha256,
  frozenLegacyBytes,
  sbomPath,
  requireCleanCheckout = true,
  verifySourceTag = true,
  verifyAttestations = verifySourceTag,
  verifyAttestation = verifyCanonicalAttestation,
  githubCliPath,
  attestationTimeoutMs = DEFAULT_ATTESTATION_TIMEOUT_MS,
  readSourceFile = readCommittedSourceFile,
} = {}) {
  for (const [value, label] of [
    [artifactsRoot, "artifactsRoot"],
    [output, "output"],
    [sbomPath, "sbomPath"],
  ]) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is required`);
  }
  const resolvedArtifacts = resolve(artifactsRoot);
  const resolvedOutput = resolve(output);
  const resolvedManifest = resolve(manifestPath);
  const resolvedLegacyManifest = resolve(legacyManifestPath);
  const resolvedSbom = resolve(sbomPath);
  assertPlainFile(resolvedManifest, "manifest");
  assertPlainFile(resolvedLegacyManifest, "legacy bridge manifest");
  assertPlainFile(resolvedSbom, "SPDX SBOM");
  assertEmptyOutput(resolvedOutput);

  const manifest = validateLauncherManifest({ manifestPath: resolvedManifest });
  if (verifySourceTag) assertReleaseSource(manifest, requireCleanCheckout);
  const releaseToolchain = exactSourceReleaseToolchain(manifest, readSourceFile);

  let legacyManifestBytes;
  if (manifest.runtimeVersion === LEGACY_BRIDGE_CONTRACT.runtimeVersion) {
    if (frozenLegacySha256 !== undefined || frozenLegacyBytes !== undefined) {
      throw new Error(
        `v${LEGACY_BRIDGE_CONTRACT.runtimeVersion} must derive its legacy bridge ` +
          "from the reviewed v2 manifest",
      );
    }
    const expected = Buffer.from(
      `${JSON.stringify(projectLegacyManifest(manifest), null, 2)}\n`,
    );
    legacyManifestBytes = readFileSync(resolvedLegacyManifest);
    if (!legacyManifestBytes.equals(expected)) {
      throw new Error(
        `legacy bridge manifest is not the deterministic projection of the reviewed ` +
          `v${LEGACY_BRIDGE_CONTRACT.runtimeVersion} v2 manifest`,
      );
    }
  } else {
    if (frozenLegacySha256 === undefined && frozenLegacyBytes === undefined) {
      ({ sha256: frozenLegacySha256, bytes: frozenLegacyBytes } =
        reviewedLegacyBridgeIdentity(releaseToolchain));
    } else if (frozenLegacySha256 === undefined || frozenLegacyBytes === undefined) {
      throw new Error(
        `post-v${LEGACY_BRIDGE_CONTRACT.runtimeVersion} legacy bridge identity must include ` +
          "SHA-256 and byte count",
      );
    }
    legacyManifestBytes = frozenLegacyManifestBytes({
      path: resolvedLegacyManifest,
      sha256: frozenLegacySha256,
      bytes: frozenLegacyBytes,
    });
  }

  const suppliedSbom = readFileSync(resolvedSbom);
  const expectedSbom = expectedSbomBytes(manifest, readSourceFile);
  if (!suppliedSbom.equals(expectedSbom)) {
    throw new Error("SPDX SBOM bytes do not match the deterministic manifest-source SBOM");
  }

  const downloaded = collect(resolvedArtifacts);
  const selected = [];
  for (const artifact of manifest.artifacts) {
    const name = basename(new URL(artifact.url).pathname);
    const sidecar = `${name}.meta.json`;
    const bundleName = `${name}.sigstore.json`;
    const buildBundleName = `${name}.build.sigstore.json`;
    const hasBuildProvenance =
      artifact.buildProvenanceUrl !== undefined ||
      artifact.buildProvenanceSha256 !== undefined ||
      artifact.buildProvenanceBytes !== undefined;
    const useBuildProvenance =
      runtimeVersionRequiresDualProvenance(manifest.runtimeVersion) ||
      hasBuildProvenance;
    const assetNames = [name, sidecar, bundleName];
    if (useBuildProvenance) assetNames.push(buildBundleName);
    for (const assetName of assetNames) {
      const source = downloaded.get(assetName);
      if (source === undefined) throw new Error(`manifest release asset is missing: ${assetName}`);
      selected.push([assetName, source]);
    }
    const metadataPath = downloaded.get(sidecar);
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch (error) {
      throw new Error(`runtime metadata is invalid JSON: ${sidecar}`, {
        cause: error,
      });
    }
    const expectedReleaseCandidate = manifest.build?.releaseCandidate;
    validateRuntimeReleaseCandidateIdentity(
      metadata?.releaseCandidate,
      metadata?.sourceCommit,
      {
        required: runtimeVersionRequiresDualProvenance(manifest.runtimeVersion),
      },
    );
    if (
      metadata?.sourceCommit !== manifest.build?.sourceCommit ||
      JSON.stringify(metadata?.releaseCandidate) !==
        JSON.stringify(expectedReleaseCandidate)
    ) {
      throw new Error(`manifest release candidate binding failed for ${sidecar}`);
    }
    const metadataDigest = createHash("sha256").update(readFileSync(metadataPath)).digest("hex");
    if (metadataDigest !== artifact.metadataSha256) {
      throw new Error(`manifest provenance binding failed for ${sidecar}`);
    }
    const bytes = readFileSync(downloaded.get(name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error(`manifest binding failed for ${name}`);
    }
    const provenanceContracts = [
      {
        label: "attestation",
        kind: "promotion",
        name: bundleName,
        url: artifact.attestationUrl,
        expectedUrl: `${artifact.url}.sigstore.json`,
        sha256: artifact.attestationSha256,
        bytes: artifact.attestationBytes,
      },
      ...(useBuildProvenance ? [{
        label: "build provenance",
        kind: "build",
        name: buildBundleName,
        url: artifact.buildProvenanceUrl,
        expectedUrl: `${artifact.url}.build.sigstore.json`,
        sha256: artifact.buildProvenanceSha256,
        bytes: artifact.buildProvenanceBytes,
      }] : []),
    ];
    for (const provenance of provenanceContracts) {
      if (provenance.url !== provenance.expectedUrl) {
        throw new Error(
          `manifest ${provenance.label} URL is not canonical for ${name}`,
        );
      }
      if (
        !/^[0-9a-f]{64}$/.test(provenance.sha256 ?? "") ||
        !Number.isSafeInteger(provenance.bytes) ||
        provenance.bytes <= 0 ||
        provenance.bytes > MAX_ATTESTATION_BUNDLE_BYTES
      ) {
        throw new Error(
          `manifest ${provenance.label} identity is invalid for ${name}`,
        );
      }
      const bundlePath = downloaded.get(provenance.name);
      const bundle = readFileSync(bundlePath);
      const bundleDigest = createHash("sha256").update(bundle).digest("hex");
      if (
        bundle.length !== provenance.bytes ||
        bundleDigest !== provenance.sha256
      ) {
        throw new Error(
          `manifest ${provenance.label} binding failed for ${provenance.name}`,
        );
      }
      try {
        const parsed = JSON.parse(bundle.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("bundle root is not an object");
        }
      } catch (error) {
        throw new Error(`canonical Sigstore bundle is invalid JSON: ${provenance.name}`, {
          cause: error,
        });
      }
      if (verifyAttestations) {
        for (const subjectPath of [downloaded.get(name), metadataPath]) {
          verifyAttestation(subjectPath, bundlePath, manifest, {
            githubCliPath,
            timeoutMs: attestationTimeoutMs,
            provenanceKind: provenance.kind,
          });
        }
      }
    }
  }

  selected.push(...nodeBootstrapReleaseAssets({
    releaseToolchain,
    manifest,
    downloaded,
  }));

  selected.push(
    [V2_MANIFEST_FILENAME, resolvedManifest],
    [LEGACY_MANIFEST_FILENAME, legacyManifestBytes],
    ["agenc-core.spdx.json", resolvedSbom],
  );
  for (const [name, repositoryPath, mode] of [
    ["install.sh", "scripts/install/install.sh", 0o755],
    ["install.ps1", "scripts/install/install.ps1", 0o644],
  ]) {
    const source = readSourceFile(manifest.build.sourceCommit, repositoryPath);
    if (!Buffer.isBuffer(source) || source.length === 0) {
      throw new Error(`exact-source ${name} bytes are unavailable`);
    }
    selected.push([name, source, mode]);
  }
  mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });
  for (const [name, source, mode = 0o644] of selected) {
    const destination = join(resolvedOutput, name);
    if (Buffer.isBuffer(source)) writeFileSync(destination, source, { mode });
    else copyFileSync(source, destination);
    chmodSync(destination, mode);
  }

  const sums = selected
    .map(([name]) => {
      const digest = createHash("sha256").update(readFileSync(join(resolvedOutput, name))).digest("hex");
      return `${digest}  ${name}`;
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  writeFileSync(join(resolvedOutput, "SHA256SUMS"), `${sums.join("\n")}\n`);
  chmodSync(join(resolvedOutput, "SHA256SUMS"), 0o644);
  return { output: resolvedOutput, assets: selected.length + 1 };
}

function main() {
  const args = process.argv.slice(2);
  for (const forbidden of ["--frozen-legacy-sha256", "--frozen-legacy-bytes"]) {
    if (args.includes(forbidden)) {
      throw new Error(`${forbidden} is not accepted; use the reviewed release-toolchain identity`);
    }
  }
  const result = prepareReleaseAssets({
    artifactsRoot: argument(args, "artifacts"),
    output: argument(args, "output"),
    manifestPath: argument(
      args,
      "manifest",
      join(launcherDir, "generated", V2_MANIFEST_FILENAME),
    ),
    legacyManifestPath: argument(
      args,
      "legacy-manifest",
      join(launcherDir, "release-manifests", LEGACY_MANIFEST_FILENAME),
    ),
    sbomPath: argument(args, "sbom"),
    githubCliPath: argument(args, "github-cli"),
  });
  process.stdout.write(`prepared ${result.assets} reviewed release assets in ${result.output}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`prepare-release-assets: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
