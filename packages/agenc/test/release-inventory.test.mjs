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
const version = "1.2.3";
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

function runtimeName(platform, arch) {
  return `agenc-runtime-${version}-${platform}-${arch}-node25-abi141.tar.gz`;
}

function fixture(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-inventory-"));
  const preparedRoot = join(root, "prepared");
  mkdirSync(preparedRoot);
  const manifestPath = join(root, "agenc-runtime-manifest-v2.json");
  const checksumsPath = join(root, "SHA256SUMS");
  const releasePath = join(root, "release.json");
  const manifest = {
    manifestVersion: 2,
    runtimeVersion: version,
    releaseRepository: "tetsuo-ai/agenc-releases",
    releaseTag: tag,
    artifacts: platforms.map(([platform, arch]) => {
      const name = runtimeName(platform, arch);
      return {
        platform,
        arch,
        nodeMajor: 25,
        nodeModuleAbi: "141",
        url:
          `https://github.com/tetsuo-ai/agenc-releases/releases/download/${tag}/${name}`,
      };
    }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const localBytes = new Map();
  localBytes.set("agenc-runtime-manifest-v2.json", readFileSync(manifestPath));
  localBytes.set("agenc-runtime-manifest.json", Buffer.from("{\"legacy\":true}\n"));
  for (const [platform, arch] of platforms) {
    const name = runtimeName(platform, arch);
    for (const asset of [name, `${name}.meta.json`, `${name}.sigstore.json`]) {
      localBytes.set(asset, Buffer.from(`fixture:${asset}\n`));
    }
  }
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
    tag_name: tag,
    draft: false,
    prerelease: false,
    immutable: true,
    assets,
  })}\n`);
  return { root, manifestPath, checksumsPath, releasePath, preparedRoot };
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
      "--tag", tag,
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
