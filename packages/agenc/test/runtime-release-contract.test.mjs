import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  canonicalRuntimeBuildProvenanceVerificationArgs,
  canonicalRuntimeAttestationVerificationArgs,
  canonicalLocalFileUrlToPath,
  canonicalRuntimeNodeBin,
  canonicalRuntimeNodeLibrary,
  FROZEN_LEGACY_RUNTIME_VERSION,
  MINIMUM_DUAL_PROVENANCE_RUNTIME_VERSION,
  MINIMUM_PRIVATE_NODE_RUNTIME_VERSION,
  PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG,
  OFFICIAL_RELEASE_REPOSITORY,
  PINNED_GITHUB_CLI_ARTIFACTS,
  PINNED_GITHUB_CLI_VERSION,
  RUNTIME_ATTESTATION_POLICY,
  RUNTIME_BUILD_PROVENANCE_POLICY,
  RUNTIME_MANIFEST_TRUST_MODES,
  requireSupportedRuntimeVersion,
  runtimeVersionRequiresDualProvenance,
  validateRuntimeReleaseManifest,
} from "../lib/runtime-release-contract.mjs";
import { LEGACY_BRIDGE_CONTRACT } from "../scripts/gen-manifest.mjs";

const repoRoot = new URL("../../../", import.meta.url);

const VERSION = "1.2.3";
const NODE_MAJOR = 26;
const NODE_MODULE_ABI = "147";
const NODE_API_VERSION = "10";

test("get.agenc.ag source preserves the landing page and release routes", () => {
  const config = JSON.parse(readFileSync(
    new URL("../../../packaging/get-agenc-ag/vercel.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(Object.keys(config).sort(), ["headers", "redirects"]);
  assert.deepEqual(config.redirects, [
    {
      source: "/install.sh",
      destination:
        "https://raw.githubusercontent.com/tetsuo-ai/agenc-core/" +
        "installer-stable/scripts/install/install.sh",
      permanent: false,
    },
    {
      source: "/install.ps1",
      destination:
        "https://raw.githubusercontent.com/tetsuo-ai/agenc-core/" +
        "installer-stable/scripts/install/install.ps1",
      permanent: false,
    },
    {
      source: "/manifest-v2.json",
      destination:
        "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/" +
        "agenc-runtime-manifest-v2.json",
      permanent: false,
    },
    {
      source: "/manifest.json",
      destination:
        "https://github.com/tetsuo-ai/agenc-releases/releases/latest/download/" +
        "agenc-runtime-manifest.json",
      permanent: false,
    },
  ]);
  assert.deepEqual(config.headers, [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        },
        {
          key: "Content-Security-Policy",
          value:
            "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
            "object-src 'none'; base-uri 'none'; form-action 'none'; " +
            "frame-ancestors 'none'; upgrade-insecure-requests",
        },
      ],
    },
  ]);

  const version = JSON.parse(readFileSync(
    new URL("../../../package.json", import.meta.url),
    "utf8",
  )).version;
  const landingPage = readFileSync(
    new URL("../../../packaging/get-agenc-ag/public/index.html", import.meta.url),
    "utf8",
  );
  const advertisedVersions = [
    ...landingPage.matchAll(/\bV(\d+\.\d+\.\d+)\b/g),
  ].map((match) => match[1]);
  assert.ok(advertisedVersions.length > 0);
  assert.deepEqual([...new Set(advertisedVersions)], [version]);
  assert.doesNotMatch(landingPage, /PRE-RELEASE/);
  assert.ok(landingPage.includes("PRIVATE NODE 26.5"));
  assert.ok(landingPage.includes("curl -fsSL https://get.agenc.ag/install.sh | sh"));
  for (const asset of ["agenc-logo.svg", "agenc-wordmark.svg"]) {
    const contents = readFileSync(
      new URL(`../../../packaging/get-agenc-ag/public/assets/${asset}`, import.meta.url),
      "utf8",
    );
    assert.match(contents, /^<svg\b/);
  }
});

test("installer promotion is exact-SHA, fast-forward-only, and lane-scoped", () => {
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/promote-installers.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /tested_sha:/u);
  assert.match(workflow, /local_evidence_sha256:/u);
  assert.match(workflow, /lane:/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /installer-stable/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /-F force=false/u);
  assert.match(
    workflow,
    /\.message == "Not Found" and \(\.status \| tostring\) == "404"/u,
  );
  assert.doesNotMatch(
    workflow,
    /git\/ref\/heads\/installer-stable"[\s\S]{0,160}\|\| true/u,
  );
  assert.match(workflow, /test "\$TESTED_SHA" = "\$GITHUB_SHA"/u);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$TESTED_SHA" refs\/remotes\/origin\/main/u,
  );
  assert.match(
    workflow,
    /test "\$\(git rev-parse refs\/remotes\/origin\/main\)" = "\$TESTED_SHA"/u,
  );
  assert.match(
    workflow,
    /installer-hotfix requires an existing full-release promotion/u,
  );
  const targetStepStart = workflow.indexOf(
    "      - name: Verify fast-forward promotion",
  );
  const promoteStepStart = workflow.indexOf(
    "      - name: Promote installer-stable",
  );
  const publicBytesStepStart = workflow.indexOf(
    "      - name: Verify public installer bytes",
  );
  assert.ok(targetStepStart >= 0);
  assert.ok(promoteStepStart > targetStepStart);
  assert.ok(publicBytesStepStart > promoteStepStart);
  const targetStep = workflow.slice(targetStepStart, promoteStepStart);
  const promoteStep = workflow.slice(promoteStepStart, publicBytesStepStart);
  assert.match(
    targetStep,
    /if \[\[ "\$current" = "\$TESTED_SHA" \]\]; then[\s\S]*else[\s\S]*git merge-base --is-ancestor "\$current" "\$TESTED_SHA"[\s\S]*installer-hotfix lane requires changed installer bytes/u,
  );
  assert.match(promoteStep, /matched=false/u);
  assert.match(promoteStep, /for attempt in \$\(seq 1 30\); do/u);
  assert.match(
    promoteStep,
    /if \[\[ "\$observed" = "\$TESTED_SHA" \]\]; then[\s\S]*matched=true[\s\S]*break/u,
  );
  assert.match(
    promoteStep,
    /installer-stable did not converge to \$TESTED_SHA/u,
  );
  const toolchain = JSON.parse(readFileSync(
    new URL("../../../release-toolchain.json", import.meta.url),
    "utf8",
  ));
  assert.match(
    workflow,
    new RegExp(`NODE_VERSION: "${toolchain.nodeVersion.replaceAll(".", "\\.")}"`, "u"),
  );
  assert.match(
    workflow,
    /nodeDistributions"\]\["linux-x64"\]\["sha256"\]/u,
  );
  assert.match(
    workflow,
    /nodeDistributions"\]\["linux-x64"\]\["bytes"\]/u,
  );
  assert.match(workflow, /json\.load\(open\("release-toolchain\.json"\)\)\["nodeModuleAbi"\]/u);
  assert.match(workflow, /json\.load\(open\("release-toolchain\.json"\)\)\["nodeApiVersion"\]/u);
  assert.match(workflow, /process\.versions\.modules !== process\.argv\[2\]/u);
  assert.match(workflow, /process\.versions\.napi !== process\.argv\[3\]/u);
  assert.match(workflow, /node scripts\/sync-installer-sqlite-lock\.mjs --check/u);
  assert.match(workflow, /sh -n scripts\/install\/install\.sh/u);
  assert.match(workflow, /raw\.githubusercontent\.com/u);
  assert.doesNotMatch(workflow, /npm publish|check:clean-build/u);
});

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

test("modern release identity advances while the installer legacy bridge remains frozen", () => {
  const toolchain = JSON.parse(readFileSync(
    new URL("../../../release-toolchain.json", import.meta.url),
    "utf8",
  ));
  const expected = {
    runtimeVersion: LEGACY_BRIDGE_CONTRACT.runtimeVersion,
    releaseRepository: LEGACY_BRIDGE_CONTRACT.releaseRepository,
    releaseTag: LEGACY_BRIDGE_CONTRACT.releaseTag,
  };
  assert.deepEqual({
    runtimeVersion: toolchain.legacyBridge.runtimeVersion,
    releaseRepository: toolchain.legacyBridge.releaseRepository,
    releaseTag: toolchain.legacyBridge.releaseTag,
  }, expected);
  assert.deepEqual(
    {
      nodeVersion: toolchain.nodeVersion,
      nodeMajor: toolchain.nodeMajor,
      nodeModuleAbi: toolchain.nodeModuleAbi,
      nodeApiVersion: toolchain.nodeApiVersion,
    },
    {
      nodeVersion: "26.5.0",
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: NODE_MODULE_ABI,
      nodeApiVersion: NODE_API_VERSION,
    },
  );
  assert.deepEqual({
    nodeMajor: LEGACY_BRIDGE_CONTRACT.nodeMajor,
    nodeModuleAbi: LEGACY_BRIDGE_CONTRACT.nodeModuleAbi,
    nodeApiVersion: LEGACY_BRIDGE_CONTRACT.nodeApiVersion,
  }, {
    nodeMajor: 25,
    nodeModuleAbi: "141",
    nodeApiVersion: "10",
  });
  assert.equal(
    toolchain.nodeBootstrap.minimumRuntimeVersion,
    MINIMUM_PRIVATE_NODE_RUNTIME_VERSION,
  );
  assert.equal(
    toolchain.nodeBootstrap.releaseTag,
    PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG,
  );
  assert.equal(
    PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG,
    `agenc-v${MINIMUM_PRIVATE_NODE_RUNTIME_VERSION}`,
  );

  for (const path of ["scripts/install/install.sh", "scripts/install/install.ps1"]) {
    const source = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    const versions = [...source.matchAll(/0\.\d+\.\d+/g)].map((match) => match[0]);
    const tags = [...source.matchAll(/agenc-v\d+\.\d+\.\d+/g)].map((match) => match[0]);
    assert.ok(versions.length > 0, `${path} has no hard-coded legacy bridge version`);
    assert.ok(tags.length > 0, `${path} has no hard-coded legacy bridge tag`);
    const expectedVersions = [
      ...new Set([
        expected.runtimeVersion,
        MINIMUM_PRIVATE_NODE_RUNTIME_VERSION,
      ]),
    ];
    const expectedTags = path.endsWith(".sh")
      ? [expected.releaseTag, PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG]
      : [expected.releaseTag];
    assert.deepEqual([...new Set(versions)].sort(), expectedVersions.sort(), path);
    assert.deepEqual([...new Set(tags)].sort(), expectedTags.sort(), path);
    assert.ok(source.includes(
      `releases/download/${expected.releaseTag}/agenc-runtime-manifest.json`,
    ), `${path} legacy manifest URL`);
    const expectedArtifactVersion = path.endsWith(".sh")
      ? "agenc-runtime-${bridgeVersion}-"
      : `agenc-runtime-${expected.runtimeVersion}-`;
    assert.ok(source.includes(expectedArtifactVersion), `${path} legacy artifact URL`);
    if (path.endsWith(".sh")) {
      assert.ok(source.includes(
        `NODE_COMPAT_RELEASE_TAG="${PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG}"`,
      ), `${path} private Node compatibility bootstrap release`);
      assert.ok(source.includes(
        "releases/download/${NODE_COMPAT_RELEASE_TAG}/${NODE_COMPAT_FILE}",
      ), `${path} private Node compatibility bootstrap URL`);
    }
  }
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
  assert.deepEqual(canonicalRuntimeBuildProvenanceVerificationArgs({
    subjectPath: "artifact",
    bundlePath: "build-bundle",
    sourceCommit: commit,
  }), [
    "attestation", "verify", "artifact",
    "--repo", RUNTIME_BUILD_PROVENANCE_POLICY.repository,
    "--bundle", "build-bundle",
    "--signer-workflow", RUNTIME_BUILD_PROVENANCE_POLICY.signerWorkflow,
    "--signer-digest", commit,
    "--source-digest", commit,
    "--source-ref", "refs/heads/main",
    "--hostname", RUNTIME_BUILD_PROVENANCE_POLICY.hostname,
    "--cert-oidc-issuer", RUNTIME_BUILD_PROVENANCE_POLICY.oidcIssuer,
    "--predicate-type", RUNTIME_BUILD_PROVENANCE_POLICY.predicateType,
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
      releaseCandidate: {
        workflow: "release-runtime.yml",
        runId: 123456,
        runAttempt: 1,
        runUrl: "https://github.com/tetsuo-ai/agenc-core/actions/runs/123456",
        phase: "candidate",
        sourceRef: "refs/heads/main",
        evidenceSha256: "9".repeat(64),
      },
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
      bins: {
        agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc",
        node: "node_modules/.agenc-node/bin/node",
        nodeLibrary: "node_modules/.agenc-node/lib",
      },
    }],
  };
}

function attachCanonicalAttestation(manifest) {
  const artifact = manifest.artifacts[0];
  artifact.attestationUrl = `${artifact.url}.sigstore.json`;
  artifact.buildProvenanceUrl = `${artifact.url}.build.sigstore.json`;
  artifact.buildProvenanceSha256 = "e".repeat(64);
  artifact.buildProvenanceBytes = 1;
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

test("modern v2 artifacts bind the platform-specific private Node entrypoint", () => {
  assert.equal(FROZEN_LEGACY_RUNTIME_VERSION, "0.7.2");
  assert.equal(MINIMUM_PRIVATE_NODE_RUNTIME_VERSION, "0.11.2");
  assert.equal(PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG, "agenc-v0.11.2");
  assert.equal(MINIMUM_DUAL_PROVENANCE_RUNTIME_VERSION, "0.13.0");
  assert.equal(runtimeVersionRequiresDualProvenance("0.12.999"), false);
  assert.equal(runtimeVersionRequiresDualProvenance("0.13.0"), true);
  assert.equal(runtimeVersionRequiresDualProvenance("1.0.0"), true);
  assert.equal(requireSupportedRuntimeVersion("0.7.2"), "0.7.2");
  assert.equal(requireSupportedRuntimeVersion("0.11.2"), "0.11.2");
  assert.equal(requireSupportedRuntimeVersion("0.11.3"), "0.11.3");
  assert.throws(
    () => requireSupportedRuntimeVersion("0.11.0"),
    /no supported standalone activation contract/,
  );
  assert.throws(
    () => requireSupportedRuntimeVersion("0.11.1"),
    /no supported standalone activation contract/,
  );
  assert.equal(canonicalRuntimeNodeBin("linux"), "node_modules/.agenc-node/bin/node");
  assert.equal(canonicalRuntimeNodeBin("darwin"), "node_modules/.agenc-node/bin/node");
  assert.equal(canonicalRuntimeNodeBin("win"), "node_modules/.agenc-node/node.exe");
  assert.equal(canonicalRuntimeNodeLibrary("linux"), "node_modules/.agenc-node/lib");
  assert.equal(canonicalRuntimeNodeLibrary("darwin"), undefined);
  assert.equal(canonicalRuntimeNodeLibrary("win"), undefined);

  for (const mutate of [
    (artifact) => { delete artifact.bins.node; },
    (artifact) => { artifact.bins.node = "../../host-node"; },
    (artifact) => { artifact.bins.node = "node_modules/.agenc-node/node.exe"; },
    (artifact) => { delete artifact.bins.nodeLibrary; },
    (artifact) => { artifact.bins.nodeLibrary = "../../host-lib"; },
  ]) {
    const manifest = attachCanonicalAttestation(remoteManifest());
    mutate(manifest.artifacts[0]);
    assert.throws(
      () => validateRuntimeReleaseManifest(manifest, { trustMode: "official" }),
      /artifact identity is invalid/,
    );
  }
});

test("published declarations expose the private Node release contract", () => {
  const declarations = readFileSync(
    new URL("../lib/runtime-release-contract.d.mts", import.meta.url),
    "utf8",
  );
  for (const expected of [
    'FROZEN_LEGACY_RUNTIME_VERSION: "0.7.2"',
    'MINIMUM_PRIVATE_NODE_RUNTIME_VERSION: "0.11.2"',
    'PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG: "agenc-v0.11.2"',
    "readonly node?: string",
    "readonly nodeLibrary?: string",
    "canonicalRuntimeNodeBin(platform: string): string",
    "canonicalRuntimeNodeLibrary(platform: string): string | undefined",
    "requireSupportedRuntimeVersion(version: string): string",
    'MINIMUM_DUAL_PROVENANCE_RUNTIME_VERSION: "0.13.0"',
    "readonly buildProvenanceUrl?: string",
    "canonicalRuntimeBuildProvenanceVerificationArgs",
    "runtimeVersionRequiresDualProvenance(version: string): boolean",
  ]) {
    assert.match(declarations, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("retired host-Node manifests fail with an actionable compatibility diagnostic", () => {
  const retired = attachCanonicalAttestation(remoteManifest({ version: "0.10.0" }));
  assert.throws(
    () => validateRuntimeReleaseManifest(retired, { trustMode: "official" }),
    /use the frozen 0\.7\.2 bridge with host Node 25\.9, or 0\.11\.2 and newer/,
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
  delete explicitLocal.artifacts[0].buildProvenanceUrl;
  delete explicitLocal.artifacts[0].buildProvenanceSha256;
  delete explicitLocal.artifacts[0].buildProvenanceBytes;
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

test("new official releases require canonical bounded build provenance", () => {
  for (const mutate of [
    (artifact) => { delete artifact.buildProvenanceUrl; },
    (artifact) => {
      artifact.buildProvenanceUrl = "https://example.invalid/build-bundle";
    },
    (artifact) => { artifact.buildProvenanceSha256 = "0"; },
    (artifact) => { artifact.buildProvenanceBytes = 0; },
  ]) {
    const manifest = attachCanonicalAttestation(remoteManifest());
    mutate(manifest.artifacts[0]);
    assert.throws(
      () => validateRuntimeReleaseManifest(manifest, { trustMode: "official" }),
      /build provenance/,
    );
  }

  const historical = remoteManifest({ version: "0.12.0" });
  historical.artifacts[0].attestationUrl =
    `${historical.artifacts[0].url}.sigstore.json`;
  assert.equal(
    validateRuntimeReleaseManifest(historical, { trustMode: "official" }),
    historical,
  );
});

test("new official releases bind a canonical candidate run identity", () => {
  const missing = attachCanonicalAttestation(remoteManifest());
  delete missing.build.releaseCandidate;
  assert.throws(
    () => validateRuntimeReleaseManifest(missing, { trustMode: "official" }),
    /release candidate identity/,
  );

  const detached = attachCanonicalAttestation(remoteManifest());
  detached.build.releaseCandidate.runUrl =
    "https://github.com/tetsuo-ai/agenc-core/actions/runs/999";
  assert.throws(
    () => validateRuntimeReleaseManifest(detached, { trustMode: "official" }),
    /release candidate identity/,
  );
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
