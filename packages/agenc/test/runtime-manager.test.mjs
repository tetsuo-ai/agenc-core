import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  ensureRuntime,
  isInstalled,
  platformSlug,
  readManifest,
  resolveAgenCHome,
  runtimeBinPath,
  runtimeInstallDir,
  selectArtifact,
} from "../lib/runtime-manager.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Build a tiny synthetic runtime tarball with the real extraction layout so the
// full ensure() path (download → verify → extract → marker) is exercised fast.
function makeSyntheticArtifact(dir, version) {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "agenc"), "#!/usr/bin/env node\nconsole.log('ok')\n");
  const artifact = join(dir, `agenc-runtime-${version}-test.tar.gz`);
  const res = spawnSync("tar", ["-czf", artifact, "-C", tree, "node_modules"]);
  assert.equal(res.status, 0, "tar should succeed");
  return { artifact, sha256: sha256(readFileSync(artifact)) };
}

test("resolveAgenCHome prefers AGENC_HOME over HOME", () => {
  assert.equal(
    resolveAgenCHome({ AGENC_HOME: "/custom/home" }, "/user"),
    "/custom/home",
  );
  assert.equal(resolveAgenCHome({}, "/user"), join("/user", ".agenc"));
});

test("platformSlug maps win32 to win and passes arch through", () => {
  assert.deepEqual(platformSlug("win32", "x64"), { os: "win", arch: "x64" });
  assert.deepEqual(platformSlug("linux", "arm64"), {
    os: "linux",
    arch: "arm64",
  });
});

test("selectArtifact finds the matching platform and errors clearly otherwise", () => {
  const manifest = {
    artifacts: [
      { platform: "linux", arch: "x64", sha256: "a" },
      { platform: "darwin", arch: "arm64", sha256: "b" },
    ],
  };
  assert.equal(
    selectArtifact(manifest, { os: "darwin", arch: "arm64" }).sha256,
    "b",
  );
  assert.throws(
    () => selectArtifact(manifest, { os: "win", arch: "x64" }),
    /no runtime build for win-x64/,
  );
});

test("isInstalled is true only when the marker records the expected sha", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenc-mgr-"));
  try {
    assert.equal(isInstalled(dir, "abc"), false); // no marker
    writeFileSync(join(dir, ".agenc-runtime-ok"), "abc");
    assert.equal(isInstalled(dir, "abc"), true);
    assert.equal(isInstalled(dir, "different"), false); // stale sha
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureRuntime downloads (file://), verifies sha, extracts, and is idempotent", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-ensure-"));
  try {
    const version = "9.9.9";
    const { artifact, sha256: digest } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const manifest = {
      manifestVersion: 1,
      runtimeVersion: version,
      artifacts: [
        {
          platform: platformSlug().os,
          arch: platformSlug().arch,
          runtimeVersion: version,
          url: `file://${artifact}`,
          sha256: digest,
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        },
      ],
    };

    const logs = [];
    const bin = await ensureRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: (m) => logs.push(m),
    });
    assert.equal(bin, runtimeBinPath(home, version, manifest.artifacts[0]));
    assert.ok(existsSync(bin), "runtime bin should be extracted");
    assert.ok(isInstalled(runtimeInstallDir(home, version), digest));
    assert.ok(logs.some((l) => l.includes("fetching")));

    // Second call short-circuits: no "fetching" log this time.
    const logs2 = [];
    const bin2 = await ensureRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: (m) => logs2.push(m),
    });
    assert.equal(bin2, bin);
    assert.equal(
      logs2.some((l) => l.includes("fetching")),
      false,
      "verified install must not re-download",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime rejects a checksum mismatch", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-badsha-"));
  try {
    const version = "9.9.9";
    const { artifact } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const manifest = {
      runtimeVersion: version,
      artifacts: [
        {
          platform: platformSlug().os,
          arch: platformSlug().arch,
          url: `file://${artifact}`,
          sha256: "0".repeat(64), // wrong
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        },
      ],
    };
    await assert.rejects(
      ensureRuntime({ env: { AGENC_HOME: home }, manifest, log: () => {} }),
      /checksum mismatch/,
    );
    // Nothing left half-installed.
    assert.equal(isInstalled(runtimeInstallDir(home, version), "0".repeat(64)), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
