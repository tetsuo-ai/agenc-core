import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { list as listTar } from "tar";

import {
  packRelease,
  publishRelease,
  verifyRelease,
} from "../../../scripts/npm-release.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const releaseToolchain = JSON.parse(
  readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
);
const launcherVersion = JSON.parse(
  readFileSync(join(repoRoot, "packages", "agenc", "package.json"), "utf8"),
).version;
// A git-free reproducibility snapshot supplies its reviewed source identity
// explicitly. Synthetic release fixtures must use that same identity instead
// of assuming the ambient checkout is available or that the variable is absent.
const sourceCommit = process.env.AGENC_BUILD_COMMIT?.trim() || "a".repeat(40);
assert.match(sourceCommit, /^[0-9a-f]{40,64}$/);
const differentSourceCommit =
  `${sourceCommit[0] === "0" ? "1" : "0"}${sourceCommit.slice(1)}`;
const sourceTree = "c".repeat(40);
const skipManifestValidation = () => {};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digest(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agenc-npm-release-test-"));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(join(source, "generated"), { recursive: true });
  mkdirSync(output);
  writeFileSync(
    join(source, "package.json"),
    `${JSON.stringify({
      name: "@tetsuo-ai/agenc",
      version: launcherVersion,
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/tetsuo-ai/agenc-core.git",
        directory: "packages/agenc",
      },
      files: ["generated/agenc-runtime-manifest-v2.json"],
    }, null, 2)}\n`,
  );
  chmodSync(join(source, "package.json"), 0o644);
  writeFileSync(
    join(source, "generated", "agenc-runtime-manifest-v2.json"),
    `${JSON.stringify({
      manifestVersion: 2,
      runtimeVersion: launcherVersion,
      releaseRepository: "tetsuo-ai/agenc-releases",
      releaseTag: `agenc-v${launcherVersion}`,
      build: { sourceCommit },
      artifacts: [
        ["darwin", "arm64"],
        ["darwin", "x64"],
        ["linux", "arm64"],
        ["linux", "x64"],
        ["win", "x64"],
      ].map(([platform, arch], index) => {
        const key = `${platform}-${arch}`;
        const artifactName =
          `agenc-runtime-${launcherVersion}-${key}-node${releaseToolchain.nodeMajor}` +
          `-abi${releaseToolchain.nodeModuleAbi}.tar.gz`;
        return {
          platform,
          arch,
          runtimeVersion: launcherVersion,
          nodeMajor: releaseToolchain.nodeMajor,
          nodeModuleAbi: releaseToolchain.nodeModuleAbi,
          nodeApiVersion: releaseToolchain.nodeApiVersion,
          url:
            `https://github.com/tetsuo-ai/agenc-releases/releases/download/` +
            `agenc-v${launcherVersion}/${artifactName}`,
          sha256: index.toString(16).repeat(64),
          bytes: index + 1,
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        };
      }),
    }, null, 2)}\n`,
  );
  chmodSync(join(source, "generated", "agenc-runtime-manifest-v2.json"), 0o644);
  writeFileSync(
    join(source, "generated", "agenc-runtime-manifest.json"),
    '{"mustNotShip":"legacy release-only bridge"}\n',
  );
  return { root, source, output };
}

async function archivePaths(path) {
  const paths = [];
  await listTar({
    file: path,
    strict: true,
    onReadEntry(entry) {
      paths.push(entry.path);
      entry.resume();
    },
  });
  return paths;
}

async function packedFixture() {
  const work = fixture();
  const packed = await packRelease({
    cwd: work.source,
    args: ["--silent", "--pack-destination", work.output],
    git: fakeGit(),
    nodeVersion: releaseToolchain.nodeVersion,
    validateManifest: skipManifestValidation,
  });
  return { ...work, ...packed };
}

function fakeGit({
  dirty = "",
  tagCommit = sourceCommit,
  head = sourceCommit,
  tree = sourceTree,
} = {}) {
  return (args) => {
    if (args[0] === "status") return dirty;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
    if (args[0] === "rev-parse" && args[1] === "HEAD^{tree}") return tree;
    if (args[0] === "rev-parse" && args[1] === "--verify") return tagCommit;
    if (args[0] === "ls-files") {
      const path = args.at(-1);
      return path === "generated/agenc-runtime-manifest-v2.json" ? "" : path;
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

function exactRegistryReceipt(bytes) {
  return {
    shasum: digest(bytes, "sha1"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
    tarball: `https://registry.npmjs.org/@tetsuo-ai/agenc/-/agenc-${launcherVersion}.tgz`,
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/@tetsuo-ai/agenc@${launcherVersion}`,
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  };
}

function fakeNpm(
  onPublish = () => {},
  {
    registryReceipt,
    existingBytes,
    publishError,
    latestVersion = launcherVersion,
  } = {},
) {
  let publishedBytes = existingBytes;
  let publishInvocations = 0;
  const run = (args) => {
    if (args[0] === "--version") {
      return { stdout: `${releaseToolchain.npmVersion}\n`, stderr: "" };
    }
    if (args[0] === "publish") {
      publishInvocations += 1;
      publishedBytes = readFileSync(args[1]);
      onPublish(args);
      if (publishError !== undefined) throw publishError;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "view") {
      if (args[2] === "dist-tags") {
        return {
          status: 0,
          stdout: `${JSON.stringify({ latest: latestVersion })}\n`,
          stderr: "",
        };
      }
      if (registryReceipt === undefined && publishedBytes === undefined) {
        return {
          status: 1,
          stdout: `${JSON.stringify({ error: { code: "E404", summary: "missing" } })}\n`,
          stderr: "npm error E404",
        };
      }
      const receipt = registryReceipt ?? exactRegistryReceipt(publishedBytes);
      return { status: 0, stdout: `${JSON.stringify(receipt)}\n`, stderr: "" };
    }
    if (args[0] === "install") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "audit" && args[1] === "signatures") {
      return {
        status: 0,
        stdout: `${JSON.stringify({ invalid: [], missing: [] })}\n`,
        stderr: "",
      };
    }
    throw new Error(`unexpected npm invocation: ${args.join(" ")}`);
  };
  run.publishInvocations = () => publishInvocations;
  return run;
}

test("pack writes a deterministic receipt bound to exact tarball bytes", async () => {
  const work = await packedFixture();
  try {
    const bytes = readFileSync(work.artifactPath);
    const paths = await archivePaths(work.artifactPath);
    assert.ok(paths.includes("package/generated/agenc-runtime-manifest-v2.json"));
    assert.equal(paths.includes("package/generated/agenc-runtime-manifest.json"), false);
    const receipt = JSON.parse(readFileSync(work.receiptPath, "utf8"));
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.artifact, basename(work.artifactPath));
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.hashes.sha256, sha256(bytes));
    assert.equal(receipt.hashes.sha512.length, 128);
    assert.deepEqual(receipt.package, { name: "@tetsuo-ai/agenc", version: launcherVersion });
    assert.equal(receipt.source.commit, sourceCommit);
    assert.deepEqual(receipt.toolchain, {
      nodeVersion: `v${releaseToolchain.nodeVersion}`,
      npmVersion: releaseToolchain.npmVersion,
    });
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("pack accepts lifecycle output before npm's terminal JSON document", async () => {
  const work = fixture();
  try {
    const packagePath = join(work.source, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.scripts = { prepack: "node prepack-output.mjs" };
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      join(work.source, "prepack-output.mjs"),
      "process.stdout.write('[launcher package] verified 5 runtime artifact(s)\\n' +\n" +
        "  '[package modes] files=0644 dirs/bins=0755\\n');\n",
    );

    const packed = await packRelease({
      cwd: work.source,
      args: ["--silent", "--pack-destination", work.output],
      git: fakeGit(),
      nodeVersion: releaseToolchain.nodeVersion,
      validateManifest: skipManifestValidation,
    });
    assert.ok(readFileSync(packed.artifactPath).length > 0);
    assert.ok(readFileSync(packed.receiptPath).length > 0);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("pack rejects an incomplete launcher manifest before invoking npm pack", async () => {
  const work = fixture();
  let packCalls = 0;
  try {
    rmSync(join(work.source, "generated", "agenc-runtime-manifest.json"));
    await assert.rejects(
      packRelease({
        cwd: work.source,
        args: ["--silent", "--pack-destination", work.output],
        git: fakeGit(),
        nodeVersion: releaseToolchain.nodeVersion,
        runNpm(args) {
          if (args[0] === "--version") {
            return { stdout: `${releaseToolchain.npmVersion}\n`, stderr: "" };
          }
          if (args[0] === "pack") packCalls += 1;
          throw new Error(`unexpected npm invocation: ${args.join(" ")}`);
        },
      }),
      /launcher package is not release-ready/,
    );
    assert.equal(packCalls, 0);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("verify applies full validation to the manifest bytes embedded in the tarball", async () => {
  const work = await packedFixture();
  try {
    await assert.rejects(
      verifyRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(),
      }),
      /launcher package is not release-ready/,
    );
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("pack rejects dirty, untagged, and forged source identities before packing", async () => {
  for (const [name, git, expected] of [
    ["dirty", fakeGit({ dirty: "?? publishable.mjs" }), /clean tagged checkout/],
    ["tag drift", fakeGit({ tagCommit: differentSourceCommit }), /checkout does not match refs\/tags/],
  ]) {
    const work = fixture();
    try {
      await assert.rejects(
        packRelease({
          cwd: work.source,
          args: ["--silent", "--pack-destination", work.output],
          git,
          nodeVersion: releaseToolchain.nodeVersion,
          validateManifest: skipManifestValidation,
        }),
        expected,
        name,
      );
      assert.deepEqual(readdirSync(work.output), []);
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  }

  const work = fixture();
  const prior = process.env.AGENC_BUILD_COMMIT;
  process.env.AGENC_BUILD_COMMIT = differentSourceCommit;
  try {
    await assert.rejects(
      packRelease({
        cwd: work.source,
        args: ["--silent", "--pack-destination", work.output],
        git: fakeGit(),
        nodeVersion: releaseToolchain.nodeVersion,
        validateManifest: skipManifestValidation,
      }),
      /AGENC_BUILD_COMMIT does not match/,
    );
    assert.deepEqual(readdirSync(work.output), []);
  } finally {
    if (prior === undefined) delete process.env.AGENC_BUILD_COMMIT;
    else process.env.AGENC_BUILD_COMMIT = prior;
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("pack rejects lifecycle mutation of any source-bound payload byte", async () => {
  for (const lifecycle of ["prepare", "prepack", "postpack"]) {
    const work = fixture();
    try {
      const packagePath = join(work.source, "package.json");
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      pkg.scripts = { [lifecycle]: "node mutate.mjs" };
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      chmodSync(packagePath, 0o644);
      writeFileSync(
        join(work.source, "mutate.mjs"),
        "import { appendFileSync } from 'node:fs';\n" +
          "appendFileSync('generated/agenc-runtime-manifest-v2.json', ' ');\n",
      );
      await assert.rejects(
        packRelease({
          cwd: work.source,
          args: ["--silent", "--pack-destination", work.output],
          git: fakeGit(),
          nodeVersion: releaseToolchain.nodeVersion,
          validateManifest: skipManifestValidation,
        }),
        /differs from exact source|source payload/,
        lifecycle,
      );
      assert.deepEqual(readdirSync(work.output), []);
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  }
});

test("publish uploads an immutable snapshot with provenance and no repack", async () => {
  const work = await packedFixture();
  try {
    const reviewed = readFileSync(work.artifactPath);
    let invocation;
    let uploaded;
    const published = await publishRelease({
      tarball: work.artifactPath,
      receiptPath: work.receiptPath,
      cwd: work.source,
      packageRoot: work.source,
      nodeVersion: releaseToolchain.nodeVersion,
      git: fakeGit(),
      runNpm: fakeNpm((args) => {
        invocation = args;
        uploaded = readFileSync(args[1]);
      }),
      validateManifest: skipManifestValidation,
    });
    assert.deepEqual(uploaded, reviewed);
    assert.equal(invocation[0], "publish");
    assert.ok(invocation[1].endsWith(".tgz"));
    assert.ok(invocation.includes("--provenance"));
    assert.ok(invocation.includes("--access=public"));
    assert.ok(invocation.includes("--registry=https://registry.npmjs.org/"));
    assert.ok(invocation.includes("--ignore-scripts"));
    assert.ok(invocation.includes("--tag=latest"));
    assert.ok(!invocation.some((value) => value.startsWith("--workspace")));
    assert.equal(published.published, true);
    assert.equal(published.alreadyPublished, false);
    assert.equal(published.registryReceipt.shasum, digest(reviewed, "sha1"));
    assert.equal(
      published.registryReceipt.integrity,
      `sha512-${digest(reviewed, "sha512", "base64")}`,
    );
    assert.deepEqual(published.signatureAudit, { invalid: 0, missing: 0 });
    assert.deepEqual(published.distTags, { latest: launcherVersion });
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("publish fails closed when the registry receipt does not match reviewed bytes", async () => {
  const work = await packedFixture();
  try {
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(() => {}, {
          registryReceipt: {
            shasum: "0".repeat(40),
            integrity: "sha512-tampered",
            tarball:
              `https://registry.npmjs.org/@tetsuo-ai/agenc/-/agenc-${launcherVersion}.tgz`,
          },
        }),
        waitForRegistry: async () => {},
        registryReceiptAttempts: 2,
        validateManifest: skipManifestValidation,
      }),
      /registry receipt\/provenance does not match/,
    );
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("publish is idempotent for matching existing bytes and recovers an accepted upload", async () => {
  const work = await packedFixture();
  try {
    const reviewed = readFileSync(work.artifactPath);
    const alreadyRunNpm = fakeNpm(() => {
      throw new Error("matching existing versions must not be republished");
    }, { existingBytes: reviewed });
    const already = await publishRelease({
      tarball: work.artifactPath,
      receiptPath: work.receiptPath,
      cwd: work.source,
      packageRoot: work.source,
      nodeVersion: releaseToolchain.nodeVersion,
      git: fakeGit(),
      runNpm: alreadyRunNpm,
      validateManifest: skipManifestValidation,
    });
    assert.equal(already.published, false);
    assert.equal(already.alreadyPublished, true);
    assert.equal(alreadyRunNpm.publishInvocations(), 0);

    const interruptedRunNpm = fakeNpm(() => {}, {
      publishError: new Error("runner disconnected after registry accepted bytes"),
    });
    const recovered = await publishRelease({
      tarball: work.artifactPath,
      receiptPath: work.receiptPath,
      cwd: work.source,
      packageRoot: work.source,
      nodeVersion: releaseToolchain.nodeVersion,
      git: fakeGit(),
      runNpm: interruptedRunNpm,
      waitForRegistry: async () => {},
      registryReceiptAttempts: 2,
      validateManifest: skipManifestValidation,
    });
    assert.equal(recovered.published, false);
    assert.equal(recovered.alreadyPublished, true);
    assert.equal(recovered.recoveredAfterPublishFailure, true);
    assert.equal(interruptedRunNpm.publishInvocations(), 1);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("publish fails closed when an existing version is not promoted to latest", async () => {
  const work = await packedFixture();
  try {
    const reviewed = readFileSync(work.artifactPath);
    const runNpm = fakeNpm(() => {
      throw new Error("an existing immutable version must not be republished");
    }, {
      existingBytes: reviewed,
      latestVersion: "0.0.1",
    });
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm,
        waitForRegistry: async () => {},
        registryReceiptAttempts: 2,
        validateManifest: skipManifestValidation,
      }),
      /latest dist-tag is 0\.0\.1.*operator must reconcile/,
    );
    assert.equal(runNpm.publishInvocations(), 0);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("publish rejects a signalled registry lookup even with parseable receipt output", async () => {
  const work = await packedFixture();
  try {
    const reviewed = readFileSync(work.artifactPath);
    const base = fakeNpm();
    const runNpm = (args, options) => {
      if (args[0] === "view" && args[1].includes("@tetsuo-ai/agenc@")) {
        return {
          status: null,
          signal: "SIGTERM",
          stdout: `${JSON.stringify(exactRegistryReceipt(reviewed))}\n`,
          stderr: "terminated",
        };
      }
      return base(args, options);
    };
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm,
        validateManifest: skipManifestValidation,
      }),
      /npm registry lookup failed \(SIGTERM\)/,
    );
    assert.equal(base.publishInvocations(), 0);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("verify validates reviewed bytes without invoking publish", async () => {
  const work = await packedFixture();
  try {
    const runNpm = fakeNpm(() => {
      throw new Error("verify must not publish");
    });
    const verified = await verifyRelease({
      tarball: work.artifactPath,
      receiptPath: work.receiptPath,
      cwd: work.source,
      packageRoot: work.source,
      nodeVersion: releaseToolchain.nodeVersion,
      git: fakeGit(),
      runNpm,
      validateManifest: skipManifestValidation,
    });
    assert.equal(verified.bytes, readFileSync(work.artifactPath).length);
    assert.equal(verified.sha256, sha256(readFileSync(work.artifactPath)));
    assert.equal(runNpm.publishInvocations(), 0);
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("verify rejects a self-consistent tarball detached from the tagged payload", async () => {
  const reviewed = fixture();
  const tampered = fixture();
  try {
    const packagePath = join(tampered.source, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    pkg.files.push("payload.txt");
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    chmodSync(packagePath, 0o644);
    writeFileSync(join(tampered.source, "payload.txt"), "detached payload\n");
    chmodSync(join(tampered.source, "payload.txt"), 0o644);
    const packed = await packRelease({
      cwd: tampered.source,
      args: ["--silent", "--pack-destination", tampered.output],
      git: fakeGit(),
      nodeVersion: releaseToolchain.nodeVersion,
      validateManifest: skipManifestValidation,
    });
    await assert.rejects(
      verifyRelease({
        tarball: packed.artifactPath,
        receiptPath: packed.receiptPath,
        cwd: reviewed.source,
        packageRoot: reviewed.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /member inventory differs from the exact source payload/,
    );
  } finally {
    rmSync(reviewed.root, { recursive: true, force: true });
    rmSync(tampered.root, { recursive: true, force: true });
  }
});

test("publish rejects altered tarball bytes and altered receipts", async () => {
  const work = await packedFixture();
  try {
    const altered = join(work.output, "altered.tgz");
    const bytes = readFileSync(work.artifactPath);
    copyFileSync(work.artifactPath, altered);
    writeFileSync(altered, Buffer.concat([bytes, Buffer.from("tamper")]));
    await assert.rejects(
      publishRelease({
        tarball: altered,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /receipt|tarball|archive|unexpected|zlib|header/i,
    );

    const receipt = JSON.parse(readFileSync(work.receiptPath, "utf8"));
    receipt.hashes.sha256 = "0".repeat(64);
    writeFileSync(work.receiptPath, `${JSON.stringify(receipt)}\n`);
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /receipt does not match/,
    );
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("publish rejects workspace paths, unsupported flags, dirty trees, and tag drift", async () => {
  const work = await packedFixture();
  try {
    await assert.rejects(
      publishRelease({ tarball: work.source, cwd: repoRoot }),
      /explicit prebuilt \.tgz/,
    );
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        args: ["--workspace=@tetsuo-ai/agenc"],
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit(),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /unsupported npm publish option/,
    );
    await assert.rejects(
      publishRelease({ args: ["--tag=next"] }),
      /stable launcher publication requires the latest dist-tag/,
    );
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit({ dirty: "?? unexpected" }),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /clean tagged checkout/,
    );
    await assert.rejects(
      publishRelease({
        tarball: work.artifactPath,
        receiptPath: work.receiptPath,
        cwd: work.source,
        packageRoot: work.source,
        nodeVersion: releaseToolchain.nodeVersion,
        git: fakeGit({ tagCommit: differentSourceCommit }),
        runNpm: fakeNpm(),
        validateManifest: skipManifestValidation,
      }),
      /checkout does not match refs\/tags/,
    );
  } finally {
    rmSync(work.root, { recursive: true, force: true });
  }
});

test("pack rejects multi-workspace and dry-run modes", async () => {
  await assert.rejects(
    packRelease({ args: ["--workspaces"] }),
    /unsupported npm release pack option/,
  );
  await assert.rejects(
    packRelease({ args: ["--dry-run"] }),
    /unsupported npm release pack option/,
  );
  await assert.rejects(
    packRelease({ args: ["--ignore-scripts"] }),
    /unsupported npm release pack option/,
  );
});
