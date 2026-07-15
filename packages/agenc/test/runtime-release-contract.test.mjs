import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  canonicalRuntimeAttestationVerificationArgs,
  canonicalLocalFileUrlToPath,
  OFFICIAL_RELEASE_REPOSITORY,
  PINNED_GITHUB_CLI_ARTIFACTS,
  PINNED_GITHUB_CLI_VERSION,
  RUNTIME_ATTESTATION_POLICY,
  RUNTIME_MANIFEST_TRUST_MODES,
  validateRuntimeReleaseManifest,
} from "../lib/runtime-release-contract.mjs";

const repoRoot = new URL("../../../", import.meta.url);

const VERSION = "1.2.3";
const NODE_MAJOR = 25;
const NODE_MODULE_ABI = "141";
const NODE_API_VERSION = "10";

test("consumer GitHub CLI pins exactly mirror the reviewed release toolchain", () => {
  const toolchain = JSON.parse(readFileSync(
    new URL("../../../release-toolchain.json", import.meta.url),
    "utf8",
  ));
  assert.equal(PINNED_GITHUB_CLI_VERSION, toolchain.githubCli.version);
  for (const [consumerKey, toolchainKey, executable] of [
    ["linux-x64", "linuxX64", "gh_2.96.0_linux_amd64/bin/gh"],
    ["linux-arm64", "linuxArm64", "gh_2.96.0_linux_arm64/bin/gh"],
    ["darwin-x64", "macosX64", "gh_2.96.0_macOS_amd64/bin/gh"],
    ["darwin-arm64", "macosArm64", "gh_2.96.0_macOS_arm64/bin/gh"],
    ["win-x64", "windowsX64", "gh_2.96.0_windows_amd64/bin/gh.exe"],
  ]) {
    assert.deepEqual(PINNED_GITHUB_CLI_ARTIFACTS[consumerKey], {
      ...toolchain.githubCli[toolchainKey],
      executable,
    });
    assert.equal(Object.isFrozen(PINNED_GITHUB_CLI_ARTIFACTS[consumerKey]), true);
  }
  assert.equal(Object.isFrozen(PINNED_GITHUB_CLI_ARTIFACTS), true);
});

test("every runtime attestation consumer is mechanically tied to one policy", () => {
  const commit = "a".repeat(40);
  const sourceRef = "refs/tags/agenc-v1.2.3";
  assert.deepEqual(canonicalRuntimeAttestationVerificationArgs({
    subjectPath: "artifact",
    bundlePath: "bundle",
    sourceCommit: commit,
    sourceRef,
  }), [
    "attestation", "verify", "artifact",
    "--repo", RUNTIME_ATTESTATION_POLICY.repository,
    "--bundle", "bundle",
    "--signer-workflow", RUNTIME_ATTESTATION_POLICY.signerWorkflow,
    "--signer-digest", commit,
    "--source-digest", commit,
    "--source-ref", sourceRef,
    "--hostname", RUNTIME_ATTESTATION_POLICY.hostname,
    "--cert-oidc-issuer", RUNTIME_ATTESTATION_POLICY.oidcIssuer,
    "--predicate-type", RUNTIME_ATTESTATION_POLICY.predicateType,
    "--deny-self-hosted-runners",
  ]);
  const shell = readFileSync(new URL("scripts/install/install.sh", repoRoot), "utf8");
  const powershell = readFileSync(new URL("scripts/install/install.ps1", repoRoot), "utf8");
  for (const [name, value] of [
    ["PROVENANCE_REPOSITORY", RUNTIME_ATTESTATION_POLICY.repository],
    ["PROVENANCE_WORKFLOW", RUNTIME_ATTESTATION_POLICY.signerWorkflow],
    ["PROVENANCE_HOSTNAME", RUNTIME_ATTESTATION_POLICY.hostname],
    ["PROVENANCE_OIDC_ISSUER", RUNTIME_ATTESTATION_POLICY.oidcIssuer],
    ["PROVENANCE_PREDICATE_TYPE", RUNTIME_ATTESTATION_POLICY.predicateType],
  ]) {
    assert.ok(shell.includes(`${name}=${JSON.stringify(value)}`), name);
  }
  for (const [name, value] of [
    ["ProvenanceRepository", RUNTIME_ATTESTATION_POLICY.repository],
    ["ProvenanceWorkflow", RUNTIME_ATTESTATION_POLICY.signerWorkflow],
    ["ProvenanceHostname", RUNTIME_ATTESTATION_POLICY.hostname],
    ["ProvenanceOidcIssuer", RUNTIME_ATTESTATION_POLICY.oidcIssuer],
    ["ProvenancePredicateType", RUNTIME_ATTESTATION_POLICY.predicateType],
  ]) {
    assert.ok(powershell.includes(`$${name} = ${JSON.stringify(value)}`), name);
  }
  assert.match(shell, /--repo "\$PROVENANCE_REPOSITORY"[\s\S]*--deny-self-hosted-runners/);
  assert.match(powershell, /--repo \$ProvenanceRepository[\s\S]*--deny-self-hosted-runners/);
});

function remoteManifest({
  version = VERSION,
  repository = OFFICIAL_RELEASE_REPOSITORY,
} = {}) {
  const releaseTag = `agenc-v${version}`;
  return {
    manifestVersion: 2,
    runtimeVersion: version,
    releaseRepository: repository,
    releaseTag,
    build: {
      sourceCommit: "a".repeat(40),
      sourceRef: `refs/tags/${releaseTag}`,
      sourceDateEpoch: 1,
      lockfileSha256: "b".repeat(64),
      nodeVersion: `v${NODE_MAJOR}.0.0`,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_MODULE_ABI,
      nodeApiVersion: NODE_API_VERSION,
      npmVersion: "11.17.0",
      artifactProfile: "release",
    },
    artifacts: [{
      platform: "linux",
      arch: "x64",
      runtimeVersion: version,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_MODULE_ABI,
      nodeApiVersion: NODE_API_VERSION,
      url:
        `https://github.com/${repository}/releases/download/${releaseTag}/` +
        `agenc-runtime-${version}-linux-x64-node${NODE_MAJOR}` +
        `-abi${NODE_MODULE_ABI}.tar.gz`,
      sha256: "c".repeat(64),
      bytes: 1,
      attestationSha256: "d".repeat(64),
      attestationBytes: 1,
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    }],
  };
}

function attachCanonicalAttestation(manifest) {
  manifest.artifacts[0].attestationUrl = `${manifest.artifacts[0].url}.sigstore.json`;
  return manifest;
}

test("official release trust is fixed to the AgenC release repository", () => {
  const official = attachCanonicalAttestation(remoteManifest());
  assert.equal(
    validateRuntimeReleaseManifest(official, {
      trustMode: "official",
      expectedRuntimeVersion: VERSION,
    }),
    official,
  );
  assert.equal(Object.isFrozen(RUNTIME_MANIFEST_TRUST_MODES), true);

  const detached = attachCanonicalAttestation(
    remoteManifest({ repository: "attacker/releases" }),
  );
  assert.throws(
    () => validateRuntimeReleaseManifest(detached, {
      trustMode: "official",
      // Unknown JavaScript options must not be able to redefine "official".
      officialRepository: "attacker/releases",
    }),
    /releaseRepository is not official/,
  );
});

test("version pinning preserves launcher diagnostics without restricting explicit sources", () => {
  const wrongVersion = attachCanonicalAttestation(remoteManifest({ version: "9.9.9" }));
  assert.throws(
    () => validateRuntimeReleaseManifest(wrongVersion, {
      trustMode: "official",
      expectedRuntimeVersion: VERSION,
    }),
    /official runtime manifest version 9\.9\.9 does not match launcher 1\.2\.3/,
  );

  const explicitRemote = attachCanonicalAttestation(
    remoteManifest({ repository: "operator/releases" }),
  );
  assert.equal(
    validateRuntimeReleaseManifest(explicitRemote, { trustMode: "explicitHttps" }),
    explicitRemote,
  );
  const detachedRemote = structuredClone(explicitRemote);
  detachedRemote.artifacts[0].url =
    "https://mirror.example.invalid/runtime.tar.gz";
  assert.throws(
    () => validateRuntimeReleaseManifest(detachedRemote, {
      trustMode: "explicitHttps",
    }),
    /artifact URL is not canonical/,
  );

  const explicitLocal = structuredClone(explicitRemote);
  delete explicitLocal.build;
  explicitLocal.artifacts[0].url = pathToFileURL(
    process.platform === "win32" ? "C:\\agenc-runtime.tar.gz" : "/tmp/agenc-runtime.tar.gz",
  ).href;
  delete explicitLocal.artifacts[0].attestationUrl;
  delete explicitLocal.artifacts[0].attestationSha256;
  delete explicitLocal.artifacts[0].attestationBytes;
  assert.equal(
    validateRuntimeReleaseManifest(explicitLocal, { trustMode: "explicitLocal" }),
    explicitLocal,
  );
});

test("official trust requires a canonical bounded Sigstore bundle", () => {
  for (const mutate of [
    (artifact) => { delete artifact.attestationUrl; },
    (artifact) => { artifact.attestationUrl = "https://example.invalid/bundle"; },
    (artifact) => { artifact.attestationSha256 = "0"; },
    (artifact) => { artifact.attestationBytes = 0; },
  ]) {
    const manifest = attachCanonicalAttestation(remoteManifest());
    mutate(manifest.artifacts[0]);
    assert.throws(
      () => validateRuntimeReleaseManifest(manifest, { trustMode: "official" }),
      /attestation/,
    );
  }
});

test("local file URLs have one authority-free canonical spelling on every platform", () => {
  assert.equal(
    canonicalLocalFileUrlToPath("file:///opt/AgenC/runtime%20x.tar.gz", "linux"),
    "/opt/AgenC/runtime x.tar.gz",
  );
  assert.equal(
    canonicalLocalFileUrlToPath("file:///C:/AgenC/runtime%20x.tar.gz", "win32"),
    "C:\\AgenC\\runtime x.tar.gz",
  );

  const invalidOnEveryPlatform = [
    "file://server/share/runtime.tar.gz",
    "file://localhost/tmp/runtime.tar.gz",
    "file:////server/share/runtime.tar.gz",
    "file:/tmp/runtime.tar.gz",
    "FILE:///tmp/runtime.tar.gz",
    "file:///tmp/../runtime.tar.gz",
    "file:///tmp/runtime.tar.gz?copy=1",
    "file:///tmp/runtime.tar.gz#copy",
    "file:///C:runtime.tar.gz",
    "file:///%5C%5C%3F%5CC:%5Cruntime.tar.gz",
    "file:///%5C%5C.%5CC:%5Cruntime.tar.gz",
    "file:///%5C??%5CC:%5Cruntime.tar.gz",
  ];
  for (const value of invalidOnEveryPlatform) {
    for (const platform of ["linux", "win32"]) {
      assert.throws(
        () => canonicalLocalFileUrlToPath(value, platform),
        /local runtime artifact URL/,
        `${platform}: ${value}`,
      );
    }
  }
  assert.throws(
    () => canonicalLocalFileUrlToPath("file:///tmp/runtime.tar.gz", "win32"),
    /invalid for its platform|absolute drive path/,
  );
  assert.throws(
    () => canonicalLocalFileUrlToPath("file:///C:/runtime.tar.gz:payload", "win32"),
    /alternate data stream/,
  );
});

test("native local file URL conversion uses the host path contract", () => {
  const nativePath = process.platform === "win32"
    ? "C:\\AgenC\\runtime.tar.gz"
    : "/tmp/AgenC/runtime.tar.gz";
  const url = pathToFileURL(nativePath).href;
  assert.equal(canonicalLocalFileUrlToPath(url), nativePath);
});
