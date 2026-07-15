// Canonical trust contract for AgenC runtime release manifests and artifacts.
// Keep this module dependency-free and side-effect-free: the npm launcher,
// runtime updater, and standalone installer payloads all consume this policy.

import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
export const MAX_RUNTIME_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_RUNTIME_ATTESTATION_BYTES = 4 * 1024 * 1024;
export const OFFICIAL_RELEASE_REPOSITORY = "tetsuo-ai/agenc-releases";
export const OFFICIAL_SOURCE_REPOSITORY = "tetsuo-ai/agenc-core";
export const OFFICIAL_RELEASE_WORKFLOW =
  "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml";
export const RUNTIME_ATTESTATION_POLICY = Object.freeze({
  repository: OFFICIAL_SOURCE_REPOSITORY,
  signerWorkflow: OFFICIAL_RELEASE_WORKFLOW,
  hostname: "github.com",
  oidcIssuer: "https://token.actions.githubusercontent.com",
  predicateType: "https://slsa.dev/provenance/v1",
});
export const PINNED_GITHUB_CLI_VERSION = "2.96.0";
export const PINNED_GITHUB_CLI_ARTIFACTS = Object.freeze({
  "linux-x64": Object.freeze({
    file: "gh_2.96.0_linux_amd64.tar.gz",
    url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_amd64.tar.gz",
    sha256: "83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60",
    bytes: 14652560,
    executable: "gh_2.96.0_linux_amd64/bin/gh",
  }),
  "linux-arm64": Object.freeze({
    file: "gh_2.96.0_linux_arm64.tar.gz",
    url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_arm64.tar.gz",
    sha256: "06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909",
    bytes: 13321232,
    executable: "gh_2.96.0_linux_arm64/bin/gh",
  }),
  "darwin-x64": Object.freeze({
    file: "gh_2.96.0_macOS_amd64.zip",
    url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_macOS_amd64.zip",
    sha256: "4bd449df9ad639391bc62b8032546f0fe9edcd8526e06682a4f88abd8c5d163c",
    bytes: 15298430,
    executable: "gh_2.96.0_macOS_amd64/bin/gh",
  }),
  "darwin-arm64": Object.freeze({
    file: "gh_2.96.0_macOS_arm64.zip",
    url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_macOS_arm64.zip",
    sha256: "f23a0c37d963aacc3bed703ccbd59b41c5ca22101fab7f00eb2b7cad23aba463",
    bytes: 13950131,
    executable: "gh_2.96.0_macOS_arm64/bin/gh",
  }),
  "win-x64": Object.freeze({
    file: "gh_2.96.0_windows_amd64.zip",
    url: "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_windows_amd64.zip",
    sha256: "c2d6acc935cd2f00e2144d7e036d5cd82e6b6bd5594e8c75aa75ef2a4ed6aac3",
    bytes: 14821821,
    executable: "gh_2.96.0_windows_amd64/bin/gh.exe",
  }),
});
export const RUNTIME_MANIFEST_TRUST_MODES = Object.freeze([
  "official",
  "explicitHttps",
  "explicitLocal",
]);

const TRUST_MODES = new Set(RUNTIME_MANIFEST_TRUST_MODES);

export function canonicalRuntimeAttestationVerificationArgs({
  subjectPath,
  bundlePath,
  sourceCommit,
  sourceRef,
}) {
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit ?? "")) {
    throw new Error("runtime attestation policy requires an exact source commit");
  }
  if (typeof sourceRef !== "string" || !sourceRef.startsWith("refs/tags/agenc-v")) {
    throw new Error("runtime attestation policy requires the canonical release source ref");
  }
  return [
    "attestation",
    "verify",
    subjectPath,
    "--repo",
    RUNTIME_ATTESTATION_POLICY.repository,
    "--bundle",
    bundlePath,
    "--signer-workflow",
    RUNTIME_ATTESTATION_POLICY.signerWorkflow,
    "--signer-digest",
    sourceCommit,
    "--source-digest",
    sourceCommit,
    "--source-ref",
    sourceRef,
    "--hostname",
    RUNTIME_ATTESTATION_POLICY.hostname,
    "--cert-oidc-issuer",
    RUNTIME_ATTESTATION_POLICY.oidcIssuer,
    "--predicate-type",
    RUNTIME_ATTESTATION_POLICY.predicateType,
    "--deny-self-hosted-runners",
  ];
}

export function requireRuntimeManifestTrustMode(trustMode) {
  if (!TRUST_MODES.has(trustMode)) {
    throw new Error(`agenc: unsupported runtime manifest trust mode ${String(trustMode)}`);
  }
  return trustMode;
}

export function canonicalRuntimeArtifactName(manifest, artifact) {
  return `agenc-runtime-${manifest.runtimeVersion}-${artifact.platform}-${artifact.arch}` +
    `-node${artifact.nodeMajor}-abi${artifact.nodeModuleAbi}.tar.gz`;
}

function localFileUrlUsesWindowsPaths(platform) {
  if (platform === "win" || platform === "win32") return true;
  if (
    platform === "linux" ||
    platform === "darwin" ||
    platform === "freebsd" ||
    platform === "openbsd" ||
    platform === "sunos" ||
    platform === "aix"
  ) return false;
  throw new Error(`agenc: unsupported local file URL platform ${String(platform)}`);
}

/**
 * Convert a canonical, authority-free local file URL into an absolute path.
 *
 * The lexical checks run before host path conversion so a manifest cannot make
 * `file://server/share`, `file://localhost/path`, a Windows device namespace,
 * or a drive-relative path mean different things on different hosts. The
 * platform parameter also makes the same contract testable on every runner.
 */
export function canonicalLocalFileUrlToPath(
  value,
  platform = process.platform,
  label = "local runtime artifact URL",
) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    /[\0\r\n]/.test(value) ||
    !value.startsWith("file:///")
  ) {
    throw new Error(`agenc: ${label} must be an authority-free file URL`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`agenc: ${label} is invalid`);
  }
  if (
    parsed.protocol !== "file:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.host !== ""
  ) {
    throw new Error(`agenc: ${label} must not contain an authority`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`agenc: ${label} must not contain a query or fragment`);
  }
  // URL parsing intentionally normalizes localhost authorities, dot segments,
  // legacy drive separators, and scheme casing. Requiring the original bytes
  // to equal the normalized serialization rejects all of those aliases.
  if (parsed.href !== value) {
    throw new Error(`agenc: ${label} is not canonical`);
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`agenc: ${label} has invalid path encoding`);
  }
  if (decodedPathname.includes("\0")) {
    throw new Error(`agenc: ${label} contains a NUL byte`);
  }
  if (decodedPathname.startsWith("//")) {
    throw new Error(`agenc: ${label} must not use a UNC path`);
  }
  // Reject device namespace spellings even while validating a manifest for a
  // different target OS. Encoded backslashes must not turn a benign-looking
  // URL into \\?\, \\.\, or \??\ after decoding.
  const namespaceProbe = decodedPathname.slice(1).replaceAll("/", "\\");
  if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(namespaceProbe)) {
    throw new Error(`agenc: ${label} must not use a device namespace`);
  }
  if (/^\/[A-Za-z]:(?:$|[^/])/.test(decodedPathname)) {
    throw new Error(`agenc: ${label} must not use a drive-relative path`);
  }

  const windows = localFileUrlUsesWindowsPaths(platform);
  let path;
  try {
    path = fileURLToPath(parsed, { windows });
  } catch {
    throw new Error(`agenc: ${label} is invalid for its platform`);
  }
  if (windows) {
    if (!win32.isAbsolute(path) || !/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\")) {
      throw new Error(`agenc: ${label} must contain an absolute drive path`);
    }
    if (path.slice(2).includes(":")) {
      throw new Error(`agenc: ${label} must not use an alternate data stream`);
    }
  } else if (!posix.isAbsolute(path) || path.startsWith("//")) {
    throw new Error(`agenc: ${label} must contain an absolute POSIX path`);
  }
  if (pathToFileURL(path, { windows }).href !== value) {
    throw new Error(`agenc: ${label} does not round-trip canonically`);
  }
  return path;
}

function validateArtifactUrl(manifest, artifact, trustMode) {
  let parsed;
  try {
    parsed = new URL(artifact.url);
  } catch {
    throw new Error("agenc: runtime manifest artifact URL is invalid");
  }
  if (trustMode === "explicitLocal") {
    // Local URLs name files on the machine consuming the manifest, not on the
    // platform named by an unselected artifact entry.
    canonicalLocalFileUrlToPath(artifact.url);
    if (
      artifact.attestationUrl !== undefined ||
      artifact.attestationSha256 !== undefined ||
      artifact.attestationBytes !== undefined
    ) {
      throw new Error("agenc: explicit local runtime artifacts must not declare remote attestations");
    }
    return;
  }
  if (parsed.protocol !== "https:") {
    throw new Error("agenc: remote runtime manifests may only use HTTPS artifact URLs");
  }
  const expected =
    `https://github.com/${manifest.releaseRepository}/releases/download/` +
    `${manifest.releaseTag}/${canonicalRuntimeArtifactName(manifest, artifact)}`;
  if (artifact.url !== expected) {
    throw new Error("agenc: runtime manifest artifact URL is not canonical");
  }
  const hasAttestation =
    artifact.attestationUrl !== undefined ||
    artifact.attestationSha256 !== undefined ||
    artifact.attestationBytes !== undefined;
  if (trustMode === "official" || hasAttestation) {
    if (artifact.attestationUrl !== `${artifact.url}.sigstore.json`) {
      throw new Error("agenc: runtime artifact attestation URL is not canonical");
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.attestationSha256 ?? "")) {
      throw new Error("agenc: runtime artifact attestation digest is invalid");
    }
    if (
      !Number.isSafeInteger(artifact.attestationBytes) ||
      artifact.attestationBytes <= 0 ||
      artifact.attestationBytes > MAX_RUNTIME_ATTESTATION_BYTES
    ) {
      throw new Error("agenc: runtime artifact attestation size is invalid");
    }
  }
}

export function validateRuntimeReleaseManifest(
  manifest,
  {
    trustMode = "official",
    expectedRuntimeVersion,
  } = {},
) {
  requireRuntimeManifestTrustMode(trustMode);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("agenc: runtime manifest root is invalid");
  }
  if (manifest.manifestVersion !== 2) {
    throw new Error(
      `agenc: unsupported runtime manifest version ${manifest.manifestVersion ?? "missing"}`,
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.runtimeVersion ?? "")) {
    throw new Error("agenc: runtime manifest has an invalid runtimeVersion");
  }
  if (manifest.releaseTag !== `agenc-v${manifest.runtimeVersion}`) {
    throw new Error("agenc: runtime manifest releaseTag does not match runtimeVersion");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.releaseRepository ?? "")) {
    throw new Error("agenc: runtime manifest releaseRepository is invalid");
  }
  if (
    trustMode === "official" &&
    manifest.releaseRepository !== OFFICIAL_RELEASE_REPOSITORY
  ) {
    throw new Error("agenc: runtime manifest releaseRepository is not official");
  }
  if (
    expectedRuntimeVersion !== undefined &&
    manifest.runtimeVersion !== expectedRuntimeVersion
  ) {
    if (trustMode === "official") {
      throw new Error(
        `agenc: official runtime manifest version ${manifest.runtimeVersion} ` +
          `does not match launcher ${expectedRuntimeVersion}`,
      );
    }
    throw new Error(
      `agenc: runtime manifest version ${manifest.runtimeVersion} ` +
      `does not match expected ${expectedRuntimeVersion}`,
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("agenc: runtime manifest has no artifacts");
  }
  if (manifest.artifacts.length > 128) {
    throw new Error("agenc: runtime manifest has too many artifacts");
  }
  const identities = new Set();
  for (const artifact of manifest.artifacts) {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("agenc: runtime manifest artifact is invalid");
    }
    const identity = `${artifact.platform}-${artifact.arch}/abi${artifact.nodeModuleAbi ?? "?"}`;
    if (!/^(linux-(x64|arm64)|darwin-(x64|arm64)|win-x64)\/abi[0-9]+$/.test(identity)) {
      throw new Error(`agenc: runtime manifest artifact identity is invalid (${identity})`);
    }
    if (identities.has(identity)) {
      throw new Error(`agenc: duplicate runtime manifest artifact ${identity}`);
    }
    identities.add(identity);
    if (
      artifact.runtimeVersion !== manifest.runtimeVersion ||
      typeof artifact.url !== "string" ||
      !Number.isSafeInteger(artifact.nodeMajor) ||
      artifact.nodeMajor < 1 ||
      !/^\d+$/.test(artifact.nodeApiVersion ?? "") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > MAX_RUNTIME_ARTIFACT_BYTES ||
      artifact.bins?.agenc !== "node_modules/@tetsuo-ai/runtime/bin/agenc"
    ) {
      throw new Error(`agenc: runtime manifest artifact identity is invalid (${identity})`);
    }
    validateArtifactUrl(manifest, artifact, trustMode);
  }
  if (trustMode !== "explicitLocal") {
    const build = manifest.build;
    if (
      build === null ||
      typeof build !== "object" ||
      Array.isArray(build) ||
      build.sourceRef !== `refs/tags/${manifest.releaseTag}` ||
      !/^[0-9a-f]{40,64}$/.test(build.sourceCommit ?? "") ||
      !Number.isSafeInteger(build.sourceDateEpoch) ||
      build.sourceDateEpoch < 0 ||
      !/^[0-9a-f]{64}$/.test(build.lockfileSha256 ?? "") ||
      !/^v\d+\.\d+\.\d+$/.test(build.nodeVersion ?? "") ||
      !Number.isSafeInteger(build.nodeMajor) ||
      !/^\d+$/.test(build.nodeModuleAbi ?? "") ||
      !/^\d+$/.test(build.nodeApiVersion ?? "") ||
      !/^\d+\.\d+\.\d+$/.test(build.npmVersion ?? "") ||
      build.artifactProfile !== "release" ||
      Number(build.nodeVersion.slice(1).split(".")[0]) !== build.nodeMajor
    ) {
      throw new Error("agenc: runtime manifest build provenance is invalid");
    }
    for (const artifact of manifest.artifacts) {
      if (
        artifact.nodeMajor !== build.nodeMajor ||
        artifact.nodeModuleAbi !== build.nodeModuleAbi ||
        artifact.nodeApiVersion !== build.nodeApiVersion
      ) {
        throw new Error("agenc: runtime manifest artifact disagrees with build provenance");
      }
    }
  }
  return manifest;
}
