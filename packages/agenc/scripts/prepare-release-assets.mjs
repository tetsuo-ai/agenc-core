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
  RUNTIME_ATTESTATION_POLICY,
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
    const output = join(work, "agenc-core.spdx.json");
    writeFileSync(
      lockfile,
      readSourceFile(manifest.build.sourceCommit, "package-lock.json"),
      { mode: 0o600 },
    );
    const generated = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "generate-spdx-sbom.mjs"),
        "--lockfile", lockfile,
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

function verifyCanonicalAttestation(
  subjectPath,
  bundlePath,
  manifest,
  { githubCliPath, timeoutMs },
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
      canonicalAttestationVerificationArgs(subjectPath, bundlePath, manifest),
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
  releaseToolchainPath = join(repoRoot, "release-toolchain.json"),
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

  let legacyManifestBytes;
  if (manifest.runtimeVersion === LEGACY_BRIDGE_CONTRACT.runtimeVersion) {
    if (frozenLegacySha256 !== undefined || frozenLegacyBytes !== undefined) {
      throw new Error("v0.6.2 must derive its legacy bridge from the reviewed v2 manifest");
    }
    const expected = Buffer.from(
      `${JSON.stringify(projectLegacyManifest(manifest), null, 2)}\n`,
    );
    legacyManifestBytes = readFileSync(resolvedLegacyManifest);
    if (!legacyManifestBytes.equals(expected)) {
      throw new Error(
        "legacy bridge manifest is not the deterministic projection of the reviewed v0.6.2 v2 manifest",
      );
    }
  } else {
    if (frozenLegacySha256 === undefined && frozenLegacyBytes === undefined) {
      const toolchain = JSON.parse(readFileSync(resolve(releaseToolchainPath), "utf8"));
      ({ sha256: frozenLegacySha256, bytes: frozenLegacyBytes } =
        reviewedLegacyBridgeIdentity(toolchain));
    } else if (frozenLegacySha256 === undefined || frozenLegacyBytes === undefined) {
      throw new Error("post-v0.6.2 legacy bridge identity must include SHA-256 and byte count");
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
    for (const assetName of [name, sidecar, bundleName]) {
      const source = downloaded.get(assetName);
      if (source === undefined) throw new Error(`manifest release asset is missing: ${assetName}`);
      selected.push([assetName, source]);
    }
    const metadataPath = downloaded.get(sidecar);
    const metadataDigest = createHash("sha256").update(readFileSync(metadataPath)).digest("hex");
    if (metadataDigest !== artifact.metadataSha256) {
      throw new Error(`manifest provenance binding failed for ${sidecar}`);
    }
    const bytes = readFileSync(downloaded.get(name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error(`manifest binding failed for ${name}`);
    }
    const canonicalAttestationUrl = `${artifact.url}.sigstore.json`;
    if (artifact.attestationUrl !== canonicalAttestationUrl) {
      throw new Error(`manifest attestation URL is not canonical for ${name}`);
    }
    if (
      !/^[0-9a-f]{64}$/.test(artifact.attestationSha256 ?? "") ||
      !Number.isSafeInteger(artifact.attestationBytes) ||
      artifact.attestationBytes <= 0 ||
      artifact.attestationBytes > MAX_ATTESTATION_BUNDLE_BYTES
    ) {
      throw new Error(`manifest attestation identity is invalid for ${name}`);
    }
    const bundlePath = downloaded.get(bundleName);
    const bundle = readFileSync(bundlePath);
    const bundleDigest = createHash("sha256").update(bundle).digest("hex");
    if (
      bundle.length !== artifact.attestationBytes ||
      bundleDigest !== artifact.attestationSha256
    ) {
      throw new Error(`manifest attestation binding failed for ${bundleName}`);
    }
    try {
      const parsed = JSON.parse(bundle.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("bundle root is not an object");
      }
    } catch (error) {
      throw new Error(`canonical Sigstore bundle is invalid JSON: ${bundleName}`, {
        cause: error,
      });
    }
    if (verifyAttestations) {
      verifyAttestation(downloaded.get(name), bundlePath, manifest, {
        githubCliPath,
        timeoutMs: attestationTimeoutMs,
      });
      verifyAttestation(metadataPath, bundlePath, manifest, {
        githubCliPath,
        timeoutMs: attestationTimeoutMs,
      });
    }
  }

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
