import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const validator = join(repoRoot, "scripts", "validate-runtime-release-inventory.py");
const releaseToolchain = JSON.parse(
  readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
);
const version = releaseToolchain.nodeBootstrap.minimumRuntimeVersion;
const tag = `agenc-v${version}`;
const platforms = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win", "x64"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeName(platform, arch, runtimeVersion = version) {
  return `agenc-runtime-${runtimeVersion}-${platform}-${arch}-node26-abi147.tar.gz`;
}

function fixture(mutate = () => {}, {
  runtimeVersion = version,
} = {}) {
  const releaseTag = `agenc-v${runtimeVersion}`;
  const root = mkdtempSync(join(tmpdir(), "agenc-release-inventory-"));
  const preparedRoot = join(root, "prepared");
  mkdirSync(preparedRoot);
  const manifestPath = join(root, "agenc-runtime-manifest-v2.json");
  const checksumsPath = join(root, "SHA256SUMS");
  const releasePath = join(root, "release.json");
  const toolchainPath = join(root, "release-toolchain.json");
  const manifest = {
    manifestVersion: 2,
    runtimeVersion,
    releaseRepository: "tetsuo-ai/agenc-releases",
    releaseTag,
    artifacts: platforms.map(([platform, arch]) => {
      const name = runtimeName(platform, arch, runtimeVersion);
      return {
        platform,
        arch,
        nodeMajor: 26,
        nodeModuleAbi: "147",
        url:
          `https://github.com/tetsuo-ai/agenc-releases/releases/download/${releaseTag}/${name}`,
      };
    }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const localBytes = new Map();
  localBytes.set("agenc-runtime-manifest-v2.json", readFileSync(manifestPath));
  localBytes.set("agenc-runtime-manifest.json", Buffer.from("{\"legacy\":true}\n"));
  const fixtureToolchain = structuredClone(releaseToolchain);
  if (releaseTag === fixtureToolchain.nodeBootstrap.releaseTag) {
    for (const arch of ["arm64", "x64"]) {
      const key = `linux-${arch}`;
      const name = fixtureToolchain.nodeBootstrap[key].file;
      const bytes = Buffer.from(`fixture:${name}\n`);
      localBytes.set(name, bytes);
      fixtureToolchain.nodeBootstrap[key].sha256 = sha256(bytes);
      fixtureToolchain.nodeBootstrap[key].bytes = bytes.length;
    }
  }
  for (const [platform, arch] of platforms) {
    const name = runtimeName(platform, arch, runtimeVersion);
    for (const asset of [name, `${name}.meta.json`, `${name}.sigstore.json`]) {
      localBytes.set(asset, Buffer.from(`fixture:${asset}\n`));
    }
  }
  writeFileSync(toolchainPath, `${JSON.stringify(fixtureToolchain, null, 2)}\n`);
  for (const [name, bytes] of localBytes) {
    if (name !== "agenc-runtime-manifest-v2.json") writeFileSync(join(root, name), bytes);
  }

  const preparedBytes = new Map(localBytes);
  for (const name of ["agenc-core.spdx.json", "install.sh", "install.ps1"]) {
    preparedBytes.set(name, Buffer.from(`remote:${name}\n`));
  }
  const checksums = new Map(
    [...preparedBytes].map(([name, bytes]) => [name, sha256(bytes)]),
  );
  const assets = [...checksums].map(([name, digest]) => ({
    name,
    state: "uploaded",
    digest: `sha256:${digest}`,
    size: preparedBytes.get(name).length,
  }));
  mutate({ checksums, assets, preparedBytes });

  const checksumBytes = Buffer.from(
    [...checksums]
      .map(([name, digest]) => `${digest}  ${name}\n`)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .join(""),
  );
  writeFileSync(checksumsPath, checksumBytes);
  assets.push({
    name: "SHA256SUMS",
    state: "uploaded",
    digest: `sha256:${sha256(checksumBytes)}`,
    size: checksumBytes.length,
  });
  preparedBytes.set("SHA256SUMS", checksumBytes);
  for (const [name, bytes] of preparedBytes) {
    writeFileSync(join(preparedRoot, name), bytes);
  }
  writeFileSync(releasePath, `${JSON.stringify({
    tag_name: releaseTag,
    draft: false,
    prerelease: false,
    immutable: true,
    assets,
  })}\n`);
  return {
    root,
    manifestPath,
    checksumsPath,
    releasePath,
    preparedRoot,
    releaseTag,
    toolchainPath,
  };
}

function run(work) {
  return spawnSync(
    "python3",
    [
      validator,
      "--release-json", work.releasePath,
      "--manifest", work.manifestPath,
      "--checksums", work.checksumsPath,
      "--asset-root", work.root,
      "--prepared-root", work.preparedRoot,
      "--toolchain", work.toolchainPath,
      "--tag", work.releaseTag,
    ],
    { encoding: "utf8" },
  );
}

test("immutable runtime release inventory accepts only the exact asset graph", () => {
  const valid = fixture();
  try {
    const result = run(valid);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
  }

  const cases = [
    ["missing installer", ({ checksums, assets }) => {
      checksums.delete("install.sh");
      assets.splice(assets.findIndex(({ name }) => name === "install.sh"), 1);
    }],
    ["missing bundle", ({ checksums, assets }) => {
      const name = `${runtimeName("linux", "x64")}.sigstore.json`;
      checksums.delete(name);
      assets.splice(assets.findIndex((asset) => asset.name === name), 1);
    }],
    ["missing Node bootstrap compatibility asset", ({ checksums, assets }) => {
      const name = "agenc-node-bootstrap-libatomic-linux-arm64.tar.gz";
      checksums.delete(name);
      assets.splice(assets.findIndex((asset) => asset.name === name), 1);
    }],
    ["extra asset", ({ checksums, assets }) => {
      const digest = sha256(Buffer.from("surprise\n"));
      checksums.set("surprise.bin", digest);
      assets.push({ name: "surprise.bin", state: "uploaded", digest: `sha256:${digest}`, size: 9 });
    }],
    ["duplicate asset", ({ assets }) => {
      assets.push({ ...assets[0] });
    }],
    ["API digest drift", ({ assets }) => {
      assets[0].digest = `sha256:${"0".repeat(64)}`;
    }],
    ["prepared installer substitution", ({ preparedBytes }) => {
      preparedBytes.set("install.sh", Buffer.from("substituted installer\n"));
    }],
    ["prepared asset missing", ({ preparedBytes }) => {
      preparedBytes.delete("install.ps1");
    }],
    ["prepared asset extra", ({ preparedBytes }) => {
      preparedBytes.set("surprise.bin", Buffer.from("surprise\n"));
    }],
  ];
  for (const [label, mutate] of cases) {
    const work = fixture(mutate);
    try {
      const result = run(work);
      assert.notEqual(result.status, 0, label);
      assert.match(
        result.stderr,
        /inventory is incomplete|extras|duplicate release asset|digest, state, or size mismatch|prepared release/,
        label,
      );
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  }
});

test("future patch releases do not republish the immutable Node bootstrap", () => {
  const futureVersion = "0.11.1";
  const valid = fixture(() => {}, { runtimeVersion: futureVersion });
  try {
    const result = run(valid);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
  }

  const republished = fixture(({ checksums, assets, preparedBytes }) => {
    const name = releaseToolchain.nodeBootstrap["linux-x64"].file;
    const bytes = Buffer.from("redundant future bootstrap\n");
    const digest = sha256(bytes);
    checksums.set(name, digest);
    assets.push({
      name,
      state: "uploaded",
      digest: `sha256:${digest}`,
      size: bytes.length,
    });
    preparedBytes.set(name, bytes);
  }, { runtimeVersion: futureVersion });
  try {
    const result = run(republished);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inventory is incomplete or has extras/);
  } finally {
    rmSync(republished.root, { recursive: true, force: true });
  }
});
