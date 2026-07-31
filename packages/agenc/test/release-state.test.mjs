import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  acquireReleaseLock,
  checkpointSequence,
  compactCompletedLogs,
  passedGateCanResume,
  releasePlanDigest,
  validateCheckpointReceipt,
  verificationPlan,
} from "../../../scripts/release-state.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const releaseStateScript = join(repoRoot, "scripts", "release-state.mjs");
const releaseVersion = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).version;
const pinnedGitHubCliVersion = JSON.parse(
  readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
).githubCli.version;
const githubCliTargetByHost = {
  "linux:x64": "linuxX64",
  "linux:arm64": "linuxArm64",
  "darwin:x64": "macosX64",
  "darwin:arm64": "macosArm64",
  "win32:x64": "windowsX64",
};
const hostGitHubCliTarget =
  githubCliTargetByHost[`${process.platform}:${process.arch}`];

function candidateReceiptFixture({
  evidenceSha256 = "b".repeat(64),
  sha = "a".repeat(40),
  version = releaseVersion,
} = {}) {
  const successfulJobs = [
    "release-source",
    "hosted-toolchain-preflight (macos-15, darwin-arm64)",
    "hosted-toolchain-preflight (macos-15-intel, darwin-x64)",
    "hosted-toolchain-preflight (windows-2025-vs2026, win-x64)",
    "linux-tarball (ubuntu-24.04, linux-x64)",
    "linux-tarball (ubuntu-24.04-arm, linux-arm64)",
    "native-tarball (macos-15, darwin-arm64)",
    "native-tarball (macos-15-intel, darwin-x64)",
    "native-tarball (windows-2025-vs2026, win-x64)",
    "candidate-seal",
  ];
  const artifacts = Object.fromEntries(
    [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win-x64",
    ].map((slug, index) => [
      `agenc-runtime-${slug}`,
      {
        archive: `agenc-runtime-${version}-${slug}-node26-abi147.tar.gz`,
        archiveBytes: 1000 + index,
        archiveSha256: String(index + 1).repeat(64),
        metadataBytes: 2000 + index,
        metadataSha256: String(index + 2).repeat(64),
        candidateBundleBytes: 3000 + index,
        candidateBundleSha256: String(index + 3).repeat(64),
      },
    ]),
  );
  return {
    schemaVersion: 1,
    workflow: "release-runtime.yml",
    phase: "candidate",
    runId: 123456,
    runAttempt: 1,
    runUrl: "https://github.com/tetsuo-ai/agenc-core/actions/runs/123456",
    sha,
    evidenceSha256,
    successfulJobs,
    artifacts,
  };
}

function candidateCheckpointFixture(options = {}) {
  return {
    authentication: {
      type: "github-attestation",
      receiptBytes: 321,
      receiptSha256: "8".repeat(64),
      bundleBytes: 654,
      bundleSha256: "9".repeat(64),
    },
    receipt: candidateReceiptFixture(options),
  };
}

function candidateEscrowReceiptFixture({
  candidateCheckpoint = candidateCheckpointFixture(),
  version = releaseVersion,
} = {}) {
  const { authentication, receipt } = candidateCheckpoint;
  const tag = `agenc-candidate-v${version}-run-${receipt.runId}`;
  const assets = {
    "agenc-runtime-candidate-seal.json": {
      assetId: 1,
      bytes: authentication.receiptBytes,
      sha256: authentication.receiptSha256,
    },
    "agenc-runtime-candidate-seal.json.sigstore.json": {
      assetId: 2,
      bytes: authentication.bundleBytes,
      sha256: authentication.bundleSha256,
    },
  };
  let assetId = 3;
  for (const artifact of Object.values(receipt.artifacts)) {
    for (const [name, bytes, sha256] of [
      [artifact.archive, artifact.archiveBytes, artifact.archiveSha256],
      [
        `${artifact.archive}.meta.json`,
        artifact.metadataBytes,
        artifact.metadataSha256,
      ],
      [
        `${artifact.archive}.sigstore.json`,
        artifact.candidateBundleBytes,
        artifact.candidateBundleSha256,
      ],
    ]) {
      assets[name] = { assetId, bytes, sha256 };
      assetId += 1;
    }
  }
  return {
    schemaVersion: 1,
    repository: "tetsuo-ai/agenc-releases",
    tag,
    url: `https://github.com/tetsuo-ai/agenc-releases/releases/tag/${tag}`,
    runId: receipt.runId,
    releaseId: 987654,
    immutable: true,
    draft: false,
    prerelease: true,
    assets,
  };
}

function candidateReleaseApiFixture(escrowReceipt) {
  return {
    id: escrowReceipt.releaseId,
    tag_name: escrowReceipt.tag,
    html_url: escrowReceipt.url,
    immutable: escrowReceipt.immutable,
    draft: escrowReceipt.draft,
    prerelease: escrowReceipt.prerelease,
    assets: Object.entries(escrowReceipt.assets).map(([name, asset]) => ({
      id: asset.assetId,
      name,
      size: asset.bytes,
      digest: `sha256:${asset.sha256}`,
      state: "uploaded",
      browser_download_url:
        `https://github.com/tetsuo-ai/agenc-releases/releases/download/` +
        `${escrowReceipt.tag}/${name}`,
    })),
  };
}

function writePassingReleaseState(root, {
  checkpoints = {},
  evidenceSha256 = "b".repeat(64),
  sha = "a".repeat(40),
} = {}) {
  const directory = join(root, `agenc-v${releaseVersion}-${sha}`);
  const statePath = join(directory, "state.json");
  const plan = verificationPlan("full");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      repository: "tetsuo-ai/agenc-core",
      lane: "full",
      version: releaseVersion,
      tag: `agenc-v${releaseVersion}`,
      sha,
      plan: {
        digest: releasePlanDigest(plan),
        gates: plan.map(({ id, argv }) => ({ id, argv })),
      },
      verification: {
        status: "pass",
        evidenceSha256,
      },
      checkpoints,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { directory, statePath };
}

function writeFakeGitHubCli(
  root,
  {
    mutateAfterAttestation = false,
    rejectReleaseVerify = false,
    rejectAttestation = false,
    releaseApi = null,
  } = {},
) {
  const path = join(root, rejectAttestation ? "gh-reject" : "gh-accept");
  const logPath = `${path}.log`;
  const source = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  env: {
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    ...(process.env.GH_TOKEN === undefined ? {} : { GH_TOKEN_PRESENT: true }),
    ...(process.env.GITHUB_TOKEN === undefined ? {} : { GITHUB_TOKEN_PRESENT: true }),
    HOME: process.env.HOME,
  },
}) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`gh version ${pinnedGitHubCliVersion} (fixture)\n`)});
  process.exit(0);
}
if (args[0] === "attestation" && args[1] === "verify") {
  ${rejectAttestation
    ? 'process.stderr.write("fixture policy rejection\\n"); process.exit(17);'
    : `${mutateAfterAttestation ? 'fs.appendFileSync(__filename, "\\n");' : ""} process.exit(0);`}
}
if (args[0] === "release" && args[1] === "verify") {
  ${rejectReleaseVerify
    ? 'process.stderr.write("fixture immutable release rejection\\n"); process.exit(23);'
    : "process.exit(0);"}
}
if (args[0] === "api" && ${releaseApi === null ? "false" : "true"}) {
  process.stdout.write(${JSON.stringify(
    releaseApi === null ? "" : `${JSON.stringify(releaseApi)}\n`,
  )});
  process.exit(0);
}
process.stderr.write("unexpected fixture invocation\\n");
process.exit(19);
`;
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { logPath, path };
}

function writeTemporaryReleaseScriptRepo(root, githubCliPath) {
  assert.equal(typeof hostGitHubCliTarget, "string");
  const fixtureRoot = join(root, "release-script-repo");
  for (const relativePath of [
    "scripts/release-state.mjs",
    "package.json",
    "runtime/package.json",
    "packages/agenc/package.json",
    "runtime/src/version.ts",
  ]) {
    const destination = join(fixtureRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(repoRoot, relativePath)));
  }
  const toolchain = JSON.parse(
    readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
  );
  const githubCliBytes = readFileSync(githubCliPath);
  toolchain.githubCli[hostGitHubCliTarget].executableBytes =
    githubCliBytes.length;
  toolchain.githubCli[hostGitHubCliTarget].executableSha256 =
    createHash("sha256").update(githubCliBytes).digest("hex");
  writeFileSync(
    join(fixtureRoot, "release-toolchain.json"),
    `${JSON.stringify(toolchain, null, 2)}\n`,
  );
  return {
    executableBytes: githubCliBytes.length,
    executableSha256:
      toolchain.githubCli[hostGitHubCliTarget].executableSha256,
    releaseStateScript: join(fixtureRoot, "scripts", "release-state.mjs"),
  };
}

function runReleaseCheckpoint(
  root,
  step,
  args,
  {
    githubToken = "must-not-reach-verifier",
    releaseStateScriptPath = releaseStateScript,
    sha = "a".repeat(40),
  } = {},
) {
  const environment = {
    ...process.env,
    GITHUB_TOKEN: "must-not-reach-verifier",
  };
  delete environment.GH_TOKEN;
  if (githubToken !== null) environment.GH_TOKEN = githubToken;
  return spawnSync(
    process.execPath,
    [
      releaseStateScriptPath,
      "checkpoint",
      "--lane",
      "full",
      "--version",
      releaseVersion,
      "--sha",
      sha,
      "--state-root",
      root,
      "--step",
      step,
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: environment,
    },
  );
}

function runCandidateCheckpoint(root, args, options = {}) {
  return runReleaseCheckpoint(
    root,
    "candidate-build-complete",
    args,
    options,
  );
}

test("an exact release state rejects concurrent expensive operations", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-lock-test-"));
  const directory = join(root, "exact-sha");
  const paths = {
    directory,
    lock: join(directory, "operation.lock"),
  };
  const release = acquireReleaseLock(paths, "verify");
  try {
    assert.throws(
      () => acquireReleaseLock(paths, "verify"),
      /release state is already locked for verify by pid/u,
    );
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("full release verification runs each expensive gate once for an exact SHA", () => {
  const plan = verificationPlan("full");
  const ids = plan.map(({ id }) => id);
  assert.deepEqual(ids, [
    "release-preflight",
    "hosted-runner-contract",
    "installer-lock-sync",
    "typecheck",
    "full-tests",
    "runtime-build",
    "runtime-startup",
    "clean-build",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === "clean-build").length, 1);
  assert.match(
    plan.find(({ id }) => id === "clean-build").argv.join(" "),
    /--buildkit-network=host/u,
  );
  assert.match(releasePlanDigest(plan), /^[0-9a-f]{64}$/u);
  assert.deepEqual(checkpointSequence("full"), [
    "candidate-build-complete",
    "candidate-escrow-published",
    "source-tag-pushed",
    "runtime-build-complete",
    "release-draft-staged",
    "github-published",
    "installer-promoted",
    "vercel-deployed",
    "homebrew-published",
    "npm-published",
    "converged",
  ]);
});

test("candidate escrow binds the exact immutable 17-asset prerelease", () => {
  const sha = "a".repeat(40);
  const evidenceSha256 = "b".repeat(64);
  const candidateCheckpoint = candidateCheckpointFixture({
    evidenceSha256,
    sha,
  });
  const receipt = candidateEscrowReceiptFixture({ candidateCheckpoint });
  const context = {
    candidateCheckpoint,
    evidenceSha256,
    lane: "full",
    receipt,
    sha,
    step: "candidate-escrow-published",
    version: releaseVersion,
  };
  assert.equal(Object.keys(receipt.assets).length, 17);
  assert.equal(validateCheckpointReceipt(context), receipt);
  for (const [label, mutate] of [
    ["mutable release", (value) => {
      value.immutable = false;
    }],
    ["draft release", (value) => {
      value.draft = true;
    }],
    ["non-prerelease", (value) => {
      value.prerelease = false;
    }],
    ["user-selected tag", (value) => {
      value.tag = "agenc-candidate-v0.13.0-run-999999";
    }],
    ["missing asset", (value) => {
      delete value.assets["agenc-runtime-candidate-seal.json"];
    }],
    ["extra asset", (value) => {
      value.assets["surprise.txt"] = {
        assetId: 99,
        bytes: 1,
        sha256: "0".repeat(64),
      };
    }],
    ["seal byte drift", (value) => {
      value.assets["agenc-runtime-candidate-seal.json"].bytes += 1;
    }],
    ["runtime digest drift", (value) => {
      const name = Object.keys(value.assets).find((asset) =>
        asset.endsWith(".tar.gz"));
      value.assets[name].sha256 = "0".repeat(64);
    }],
  ]) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.throws(
      () => validateCheckpointReceipt({ ...context, receipt: candidate }),
      Error,
      label,
    );
  }
});

test("source tag checkpoint is gated on immutable candidate escrow evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-escrow-order-"));
  const sha = "a".repeat(40);
  const candidateCheckpoint = candidateCheckpointFixture({ sha });
  try {
    const { statePath } = writePassingReleaseState(root, {
      checkpoints: {
        "candidate-build-complete": candidateCheckpoint,
      },
      sha,
    });
    const sourceTagReceipt = JSON.stringify({
      tag: `agenc-v${releaseVersion}`,
      sha,
      promotionRunId: 24680,
    });
    const premature = runReleaseCheckpoint(
      root,
      "source-tag-pushed",
      ["--receipt-json", sourceTagReceipt],
      { sha },
    );
    assert.notEqual(premature.status, 0);
    assert.match(
      premature.stderr,
      /missing candidate-escrow-published/u,
    );

    const escrowReceipt = candidateEscrowReceiptFixture({
      candidateCheckpoint,
    });
    const fabricated = runReleaseCheckpoint(
      root,
      "candidate-escrow-published",
      ["--receipt-json", JSON.stringify(escrowReceipt)],
      { sha },
    );
    assert.notEqual(fabricated.status, 0);
    assert.match(
      fabricated.stderr,
      /does not accept operator-supplied receipts/u,
    );

    const githubCli = writeFakeGitHubCli(root, {
      releaseApi: candidateReleaseApiFixture(escrowReceipt),
    });
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);
    const missingToken = runReleaseCheckpoint(
      root,
      "candidate-escrow-published",
      ["--github-cli", githubCli.path],
      {
        githubToken: null,
        releaseStateScriptPath: fixtureRepo.releaseStateScript,
        sha,
      },
    );
    assert.notEqual(missingToken.status, 0);
    assert.match(missingToken.stderr, /requires an explicit non-empty GH_TOKEN/u);
    assert.equal(existsSync(githubCli.logPath), false);

    const escrow = runReleaseCheckpoint(
      root,
      "candidate-escrow-published",
      ["--github-cli", githubCli.path],
      {
        githubToken: "fixture-token",
        releaseStateScriptPath: fixtureRepo.releaseStateScript,
        sha,
      },
    );
    assert.equal(escrow.status, 0, escrow.stderr);
    const invocations = readFileSync(githubCli.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 3);
    assert.deepEqual(invocations[0].args, ["--version"]);
    assert.deepEqual(invocations[1].args, [
      "release",
      "verify",
      escrowReceipt.tag,
      "--repo",
      "tetsuo-ai/agenc-releases",
    ]);
    assert.deepEqual(invocations[2].args, [
      "api",
      "--method",
      "GET",
      `repos/tetsuo-ai/agenc-releases/releases/tags/${escrowReceipt.tag}`,
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]);
    for (const invocation of invocations) {
      assert.equal(invocation.env.GH_TOKEN_PRESENT, true);
      assert.equal(Object.hasOwn(invocation.env, "GITHUB_TOKEN_PRESENT"), false);
    }
    const sourceTag = runReleaseCheckpoint(
      root,
      "source-tag-pushed",
      ["--receipt-json", sourceTagReceipt],
      { sha },
    );
    assert.equal(sourceTag.status, 0, sourceTag.stderr);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(
      state.checkpoints["candidate-escrow-published"].receipt,
      escrowReceipt,
    );
    assert.deepEqual(
      {
        type:
          state.checkpoints["candidate-escrow-published"].authentication.type,
        repository:
          state.checkpoints["candidate-escrow-published"].authentication.repository,
        tag:
          state.checkpoints["candidate-escrow-published"].authentication.tag,
        apiVersion:
          state.checkpoints["candidate-escrow-published"].authentication.apiVersion,
      },
      {
        type: "github-immutable-release",
        repository: "tetsuo-ai/agenc-releases",
        tag: escrowReceipt.tag,
        apiVersion: "2026-03-10",
      },
    );
    assert.deepEqual(
      state.checkpoints["source-tag-pushed"].receipt,
      JSON.parse(sourceTagReceipt),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the candidate checkpoint binds the exact sealed run and all promoted bytes", () => {
  const sha = "a".repeat(40);
  const evidenceSha256 = "b".repeat(64);
  const version = releaseVersion;
  const receipt = candidateReceiptFixture({ evidenceSha256, sha, version });
  const context = {
    evidenceSha256,
    lane: "full",
    receipt,
    sha,
    step: "candidate-build-complete",
    version,
  };
  assert.equal(validateCheckpointReceipt(context), receipt);
  const reorderedJobs = structuredClone(receipt);
  reorderedJobs.successfulJobs.reverse();
  assert.equal(
    validateCheckpointReceipt({ ...context, receipt: reorderedJobs }),
    reorderedJobs,
  );

  for (const [label, mutate] of [
    ["empty receipt", (value) => {
      for (const key of Object.keys(value)) delete value[key];
    }],
    ["wrong run URL", (value) => {
      value.runUrl = `${value.runUrl}/attempts/1`;
    }],
    ["wrong SHA", (value) => {
      value.sha = "c".repeat(40);
    }],
    ["missing job", (value) => {
      value.successfulJobs.pop();
    }],
    ["duplicate job", (value) => {
      value.successfulJobs[0] = value.successfulJobs[1];
    }],
    ["missing artifact", (value) => {
      delete value.artifacts["agenc-runtime-win-x64"];
    }],
    ["invalid archive digest", (value) => {
      value.artifacts["agenc-runtime-linux-x64"].archiveSha256 = "0";
    }],
    ["wrong archive name", (value) => {
      value.artifacts["agenc-runtime-linux-x64"].archive =
        "agenc-runtime-0.12.0-linux-x64-node26-abi147.tar.gz";
    }],
  ]) {
    const candidate = structuredClone(receipt);
    mutate(candidate);
    assert.throws(
      () => validateCheckpointReceipt({ ...context, receipt: candidate }),
      Error,
      label,
    );
  }
});

test("candidate checkpoint CLI authenticates private receipt bytes before recording them", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-valid-"));
  const sha = "a".repeat(40);
  const evidenceSha256 = "b".repeat(64);
  try {
    const { directory, statePath } = writePassingReleaseState(root, {
      evidenceSha256,
      sha,
    });
    const receiptPath = join(root, "candidate-receipt.json");
    const bundlePath = join(root, "candidate-receipt.json.sigstore.json");
    const receiptBytes = Buffer.from(
      `${JSON.stringify(candidateReceiptFixture({ evidenceSha256, sha }), null, 2)}\n`,
      "utf8",
    );
    const bundleBytes = Buffer.from('{"fixture":"sigstore-bundle"}\n', "utf8");
    writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
    writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root);
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);

    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { releaseStateScriptPath: fixtureRepo.releaseStateScript, sha });
    assert.equal(result.status, 0, result.stderr);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const checkpoint = state.checkpoints["candidate-build-complete"];
    assert.deepEqual(checkpoint.receipt, candidateReceiptFixture({
      evidenceSha256,
      sha,
    }));
    assert.deepEqual(
      {
        type: checkpoint.authentication.type,
        repository: checkpoint.authentication.repository,
        signerWorkflow: checkpoint.authentication.signerWorkflow,
        signerDigest: checkpoint.authentication.signerDigest,
        sourceDigest: checkpoint.authentication.sourceDigest,
        sourceRef: checkpoint.authentication.sourceRef,
        githubCliPlatform: checkpoint.authentication.githubCliPlatform,
        githubCliArch: checkpoint.authentication.githubCliArch,
        githubCliTarget: checkpoint.authentication.githubCliTarget,
        githubCliVersion: checkpoint.authentication.githubCliVersion,
        githubCliExecutableBytes:
          checkpoint.authentication.githubCliExecutableBytes,
        githubCliExecutableSha256:
          checkpoint.authentication.githubCliExecutableSha256,
      },
      {
        type: "github-attestation",
        repository: "tetsuo-ai/agenc-core",
        signerWorkflow:
          "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml",
        signerDigest: sha,
        sourceDigest: sha,
        sourceRef: "refs/heads/main",
        githubCliPlatform: process.platform,
        githubCliArch: process.arch,
        githubCliTarget: hostGitHubCliTarget,
        githubCliVersion: pinnedGitHubCliVersion,
        githubCliExecutableBytes: fixtureRepo.executableBytes,
        githubCliExecutableSha256: fixtureRepo.executableSha256,
      },
    );
    assert.equal(
      checkpoint.authentication.receiptSha256,
      createHash("sha256").update(receiptBytes).digest("hex"),
    );
    assert.equal(checkpoint.authentication.receiptBytes, receiptBytes.length);
    assert.equal(
      checkpoint.authentication.bundleSha256,
      createHash("sha256").update(bundleBytes).digest("hex"),
    );
    assert.equal(checkpoint.authentication.bundleBytes, bundleBytes.length);
    const invocations = readFileSync(githubCli.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[0].args, ["--version"]);
    const verification = invocations[1];
    assert.deepEqual(verification.args.slice(0, 2), ["attestation", "verify"]);
    assert.notEqual(verification.args[2], receiptPath);
    assert.match(
      verification.args[2],
      new RegExp(`^${directory.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/\\.candidate-auth-`, "u"),
    );
    assert.deepEqual(
      verification.args.slice(3),
      [
        "--bundle",
        `${verification.args[2]}.sigstore.json`,
        "--repo",
        "tetsuo-ai/agenc-core",
        "--signer-workflow",
        "tetsuo-ai/agenc-core/.github/workflows/release-runtime.yml",
        "--signer-digest",
        sha,
        "--source-digest",
        sha,
        "--source-ref",
        "refs/heads/main",
        "--hostname",
        "github.com",
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--deny-self-hosted-runners",
      ],
    );
    assert.match(verification.env.GH_CONFIG_DIR, /\.candidate-auth-/u);
    assert.equal(Object.hasOwn(verification.env, "GH_TOKEN"), false);
    assert.equal(Object.hasOwn(verification.env, "GITHUB_TOKEN"), false);
    assert.equal(existsSync(verification.args[2]), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI rejects a version-spoofing fake against production executable pins", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-unpinned-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const receiptPath = join(root, "candidate-receipt.json");
    const bundlePath = `${receiptPath}.sigstore.json`;
    writeFileSync(
      receiptPath,
      `${JSON.stringify(candidateReceiptFixture({ sha }))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(bundlePath, "{}\n", { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root);
    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { sha });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub CLI executable byte count/u);
    assert.equal(existsSync(githubCli.logPath), false);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI rejects executable SHA-256 drift before spawning", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-hash-drift-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const receiptPath = join(root, "candidate-receipt.json");
    const bundlePath = `${receiptPath}.sigstore.json`;
    writeFileSync(
      receiptPath,
      `${JSON.stringify(candidateReceiptFixture({ sha }))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(bundlePath, "{}\n", { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root);
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);
    const tamperedBytes = readFileSync(githubCli.path);
    tamperedBytes[tamperedBytes.length - 2] ^= 1;
    writeFileSync(githubCli.path, tamperedBytes, { mode: 0o755 });
    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { releaseStateScriptPath: fixtureRepo.releaseStateScript, sha });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub CLI executable SHA-256/u);
    assert.equal(existsSync(githubCli.logPath), false);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI rechecks executable identity after attestation", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-post-drift-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const receiptPath = join(root, "candidate-receipt.json");
    const bundlePath = `${receiptPath}.sigstore.json`;
    writeFileSync(
      receiptPath,
      `${JSON.stringify(candidateReceiptFixture({ sha }))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(bundlePath, "{}\n", { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root, {
      mutateAfterAttestation: true,
    });
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);
    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { releaseStateScriptPath: fixtureRepo.releaseStateScript, sha });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /GitHub CLI executable byte count.+post-spawn verification/us,
    );
    const invocations = readFileSync(githubCli.logPath, "utf8").trim().split("\n");
    assert.equal(invocations.length, 2);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI rejects receipt JSON as an authentication bypass", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-bypass-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const result = runCandidateCheckpoint(root, [
      "--receipt-json",
      JSON.stringify(candidateReceiptFixture({ sha })),
    ], { sha });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /candidate-build-complete does not accept --receipt-json/u,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI rejects an invalid receipt only after authentication", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-invalid-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const receiptPath = join(root, "invalid-receipt.json");
    const bundlePath = `${receiptPath}.sigstore.json`;
    const receipt = candidateReceiptFixture({ sha });
    receipt.sha = "c".repeat(40);
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    writeFileSync(bundlePath, "{}\n", { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root);
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);
    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { releaseStateScriptPath: fixtureRepo.releaseStateScript, sha });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /candidate-build-complete receipt identity does not match/u,
    );
    const invocations = readFileSync(githubCli.logPath, "utf8").trim().split("\n");
    assert.equal(invocations.length, 2);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate checkpoint CLI never parses or records an attestation-rejected receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-candidate-checkpoint-rejected-"));
  const sha = "a".repeat(40);
  try {
    const { statePath } = writePassingReleaseState(root, { sha });
    const receiptPath = join(root, "rejected-receipt.json");
    const bundlePath = `${receiptPath}.sigstore.json`;
    writeFileSync(receiptPath, "not JSON\n", { mode: 0o600 });
    writeFileSync(bundlePath, "{}\n", { mode: 0o600 });
    const githubCli = writeFakeGitHubCli(root, { rejectAttestation: true });
    const fixtureRepo = writeTemporaryReleaseScriptRepo(root, githubCli.path);
    const result = runCandidateCheckpoint(root, [
      "--receipt-file",
      receiptPath,
      "--receipt-bundle",
      bundlePath,
      "--github-cli",
      githubCli.path,
    ], { releaseStateScriptPath: fixtureRepo.releaseStateScript, sha });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub attestation policy rejected/u);
    assert.doesNotMatch(result.stderr, /invalid authenticated candidate receipt JSON/u);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.checkpoints["candidate-build-complete"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed release logs compact without losing their original digests", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-compact-test-"));
  const logs = join(root, "logs");
  const statePath = join(root, "state.json");
  const logPath = join(logs, "full-tests.log");
  try {
    const bytes = Buffer.from("a long but verified gate log\n", "utf8");
    mkdirSync(logs, { mode: 0o700 });
    writeFileSync(logPath, bytes, { mode: 0o600 });
    const logSha256 = createHash("sha256").update(bytes).digest("hex");
    const state = {
      verification: {
        gates: [
          {
            id: "full-tests",
            result: "pass",
            logPath,
            logSha256,
          },
        ],
      },
      checkpoints: { converged: { receipt: { version: "1.2.3" } } },
    };
    await compactCompletedLogs(state, { state: statePath });
    assert.equal(existsSync(logPath), false);
    assert.equal(existsSync(`${logPath}.gz`), true);
    assert.deepEqual(gunzipSync(readFileSync(`${logPath}.gz`)), bytes);
    assert.equal(state.retention.logs[0].originalSha256, logSha256);
    assert.match(state.retention.logs[0].archiveSha256, /^[0-9a-f]{64}$/u);
    assert.match(state.retention.plaintextRemovedAt, /^\d{4}-\d{2}-\d{2}T/u);

    // Model interruption after the archive receipt was committed but before
    // plaintext cleanup completed. A retry verifies both copies, removes the
    // plaintext, and completes the same retention record.
    writeFileSync(logPath, bytes, { mode: 0o600 });
    state.retention.plaintextRemovedAt = null;
    await compactCompletedLogs(state, { state: statePath });
    assert.equal(existsSync(logPath), false);
    assert.match(state.retention.plaintextRemovedAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer hotfix verification is targeted and excludes runtime release gates", () => {
  const plan = verificationPlan("installer-hotfix");
  const ids = plan.map(({ id }) => id);
  assert.deepEqual(ids, [
    "installer-lock-sync",
    "installer-shell-syntax",
    "installer-runtime-tests",
    "installer-launcher-tests",
  ]);
  assert.doesNotMatch(ids.join(" "), /clean-build|release-preflight|full-tests/u);
  assert.match(
    plan.find(({ id }) => id === "installer-runtime-tests").argv.join(" "),
    /tests\/packaging\/install-sh\.test\.ts/u,
  );
  assert.deepEqual(checkpointSequence("installer-hotfix"), [
    "installer-promoted",
    "converged",
  ]);
});

test("a passing gate resumes only while its retained log matches the recorded digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-state-test-"));
  const logPath = join(root, "gate.log");
  try {
    writeFileSync(logPath, "verified\n", { mode: 0o600 });
    chmodSync(logPath, 0o600);
    const logSha256 = createHash("sha256").update("verified\n").digest("hex");
    const record = { result: "pass", logPath, logSha256 };
    assert.equal(await passedGateCanResume(record), true);
    writeFileSync(logPath, "tampered\n", { mode: 0o600 });
    assert.equal(await passedGateCanResume(record), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
