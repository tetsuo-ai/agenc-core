import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  ensureRuntime,
  isInstalled,
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_MANIFEST_BYTES,
  platformSlug,
  readManifest,
  resolveAgenCHome,
  runtimeBinPath,
  runtimeInstallDir,
  selectArtifact,
} from "../lib/runtime-manager.mjs";
import { validateRuntimeArchive } from "../lib/runtime-archive.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
).version;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const HOST_RUNTIME = {
  platform: platformSlug().os,
  arch: platformSlug().arch,
  nodeMajor: NODE_MAJOR,
  nodeModuleAbi: process.versions.modules,
  ...(platformSlug().os === "linux"
    ? {
        libcFamily: "glibc",
        glibcVersion: "2.39",
        glibcxxVersion: "3.4.33",
        cxxAbiVersion: "1.3.15",
      }
    : {}),
  ...(platformSlug().os === "darwin" ? { macosVersion: "14.0" } : {}),
};
const LOCAL_MANIFEST_TRUST = "explicitLocal";
const LOCAL_SELECT_OPTIONS = { trustMode: LOCAL_MANIFEST_TRUST };
const LOCAL_RUNTIME_URL = pathToFileURL(join(tmpdir(), "agenc-runtime.tar.gz")).href;

function compatibilityFields(platform) {
  return {
    nodeMajor: NODE_MAJOR,
    nodeModuleAbi: process.versions.modules,
    nodeApiVersion: process.versions.napi,
    ...(platform === "linux"
      ? {
          libcFamily: "glibc",
          minimumGlibcVersion: "2.28",
          minimumGlibcxxVersion: "3.4.25",
          minimumCxxAbiVersion: "1.3.11",
        }
      : {}),
    ...(platform === "darwin" ? { minimumMacosVersion: "13.5" } : {}),
  };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function rawTarHeader(path, type = "0", link = "") {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000000\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function rawTarWithMembers(members) {
  return gzipSync(Buffer.concat([
    ...members.map(([path, type = "0", link = ""]) => rawTarHeader(path, type, link)),
    Buffer.alloc(1024),
  ]));
}

function rawTarWithMember(path, type = "0", link = "") {
  return rawTarWithMembers([[path, type, link]]);
}

// Build a tiny synthetic runtime tarball with the real extraction layout so the
// full ensure() path (download → verify → extract → marker) is exercised fast.
function makeSyntheticArtifact(dir, version, binSource = "#!/usr/bin/env node\nconsole.log('ok')\n") {
  const tree = join(dir, "tree");
  const binDir = join(tree, "node_modules", "@tetsuo-ai", "runtime", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "agenc"), binSource);
  const artifact = join(dir, `agenc-runtime-${version}-test.tar.gz`);
  const res = spawnSync("tar", ["-czf", artifact, "-C", tree, "node_modules"]);
  assert.equal(res.status, 0, "tar should succeed");
  const bytes = readFileSync(artifact);
  return { artifact, sha256: sha256(bytes), bytes: bytes.length };
}

function syntheticManifest(version, artifact, digest, bytes) {
  return {
    manifestVersion: 2,
    runtimeVersion: version,
    releaseRepository: "local/test",
    releaseTag: `agenc-v${version}`,
    artifacts: [{
      platform: platformSlug().os,
      arch: platformSlug().arch,
      runtimeVersion: version,
      ...compatibilityFields(platformSlug().os),
      url: pathToFileURL(artifact).href,
      sha256: digest,
      bytes,
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    }],
  };
}

function httpsManifest(version, digest, bytes, overrides = {}) {
  const platform = platformSlug().os;
  const arch = platformSlug().arch;
  const releaseRepository = overrides.releaseRepository ?? "test/releases";
  const releaseTag = `agenc-v${version}`;
  const artifact = {
    platform,
    arch,
    runtimeVersion: version,
    ...compatibilityFields(platform),
    url:
      `https://github.com/${releaseRepository}/releases/download/${releaseTag}/` +
      `agenc-runtime-${version}-${platform}-${arch}-node${NODE_MAJOR}` +
      `-abi${process.versions.modules}.tar.gz`,
    sha256: digest,
    bytes,
    bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    ...overrides.artifact,
  };
  if (releaseRepository === "tetsuo-ai/agenc-releases") {
    artifact.attestationUrl ??= `${artifact.url}.sigstore.json`;
    artifact.attestationSha256 ??= "e".repeat(64);
    artifact.attestationBytes ??= 1;
  }
  return {
    manifestVersion: 2,
    runtimeVersion: version,
    releaseRepository,
    releaseTag,
    build: {
      sourceCommit: "a".repeat(40),
      sourceRef: `refs/tags/${releaseTag}`,
      sourceDateEpoch: 1,
      lockfileSha256: "d".repeat(64),
      nodeVersion: `v${NODE_MAJOR}.0.0`,
      nodeMajor: NODE_MAJOR,
      nodeModuleAbi: process.versions.modules,
      nodeApiVersion: process.versions.napi,
      npmVersion: "11.17.0",
      artifactProfile: "release",
    },
    artifacts: [artifact],
  };
}

function ensureLocalRuntime(options) {
  return ensureRuntime({ ...options, manifestTrust: LOCAL_MANIFEST_TRUST });
}

test("resolveAgenCHome prefers AGENC_HOME over HOME", () => {
  assert.equal(
    resolveAgenCHome({ AGENC_HOME: "/custom/home" }, "/user"),
    "/custom/home",
  );
  assert.equal(resolveAgenCHome({}, "/user"), join("/user", ".agenc"));
  assert.throws(
    () => resolveAgenCHome({ AGENC_HOME: "relative-home" }, "/user"),
    /AGENC_HOME must be an absolute path/,
  );
});

test("platformSlug maps win32 to win and passes arch through", () => {
  assert.deepEqual(platformSlug("win32", "x64"), { os: "win", arch: "x64" });
  assert.deepEqual(platformSlug("linux", "arm64"), {
    os: "linux",
    arch: "arm64",
  });
});

test("readManifest accepts the exact 1 MiB boundary and rejects one byte more", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-bounded-manifest-"));
  try {
    const exact = join(work, "exact.json");
    const exactBytes = Buffer.alloc(MAX_RUNTIME_MANIFEST_BYTES, 0x20);
    exactBytes.write("{}", 0, "utf8");
    writeFileSync(exact, exactBytes);
    assert.deepEqual(readManifest(exact), {});

    const oversized = join(work, "oversized.json");
    writeFileSync(oversized, Buffer.alloc(MAX_RUNTIME_MANIFEST_BYTES + 1, 0x20));
    assert.throws(
      () => readManifest(oversized),
      new RegExp(`runtime manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("manifest trust rejects duplicates, detached repositories, and remote file access", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-manifest-trust-"));
  try {
    const artifactPath = join(work, "sentinel.tar.gz");
    writeFileSync(artifactPath, "sentinel");
    const local = syntheticManifest("1.2.3", artifactPath, "a".repeat(64), 8);
    assert.equal(
      selectArtifact(
        local,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
        LOCAL_SELECT_OPTIONS,
      ).url,
      pathToFileURL(artifactPath).href,
    );
    assert.throws(
      () => selectArtifact(local, platformSlug(), process.versions.modules, HOST_RUNTIME),
      /releaseRepository is not official/,
    );

    const official = httpsManifest(LAUNCHER_VERSION, "c".repeat(64), 8, {
      releaseRepository: "tetsuo-ai/agenc-releases",
    });
    assert.equal(
      selectArtifact(
        official,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
      ).sha256,
      "c".repeat(64),
    );
    official.artifacts[0].url += "?detached=1";
    assert.throws(
      () => selectArtifact(
        official,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
      ),
      /artifact URL is not canonical/,
    );
    const wrongOfficialVersion = httpsManifest("9.9.9", "c".repeat(64), 8, {
      releaseRepository: "tetsuo-ai/agenc-releases",
    });
    assert.throws(
      () => selectArtifact(
        wrongOfficialVersion,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
      ),
      /does not match launcher/,
    );

    const duplicate = structuredClone(local);
    duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
    assert.throws(
      () => selectArtifact(
        duplicate,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
        LOCAL_SELECT_OPTIONS,
      ),
      /duplicate runtime manifest artifact/,
    );

    const localAuthority = structuredClone(local);
    localAuthority.artifacts[0].url = "file://server/share/runtime.tar.gz";
    assert.throws(
      () => selectArtifact(
        localAuthority,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
        LOCAL_SELECT_OPTIONS,
      ),
      /authority-free file URL|must not contain an authority/,
    );

    const remote = httpsManifest("1.2.3", "b".repeat(64), 8);
    remote.artifacts[0].url = pathToFileURL(artifactPath).href;
    assert.throws(
      () => selectArtifact(
        remote,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
        { trustMode: "explicitHttps" },
      ),
      /only use HTTPS artifact URLs/,
    );
    delete remote.releaseRepository;
    assert.throws(
      () => selectArtifact(
        remote,
        platformSlug(),
        process.versions.modules,
        HOST_RUNTIME,
        { trustMode: "explicitHttps" },
      ),
      /releaseRepository is invalid/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("artifact ceiling rejection happens before install-state mutation", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-artifact-ceiling-"));
  try {
    const artifactPath = join(work, "runtime.tar.gz");
    writeFileSync(artifactPath, "x");
    const manifest = syntheticManifest(
      "1.2.4",
      artifactPath,
      "a".repeat(64),
      MAX_RUNTIME_ARTIFACT_BYTES + 1,
    );
    const home = join(work, "home");
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
      }),
      /artifact identity is invalid/,
    );
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ABI incompatibility gives reinstall guidance before install-state mutation", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-artifact-abi-guidance-"));
  try {
    const artifactPath = join(work, "runtime.tar.gz");
    writeFileSync(artifactPath, "x");
    const manifest = syntheticManifest("1.2.5", artifactPath, "a".repeat(64), 1);
    manifest.artifacts[0].nodeModuleAbi = "999";
    const home = join(work, "home");
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
      }),
      /reinstall @tetsuo-ai\/agenc before retrying; no runtime was downloaded/,
    );
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("selectArtifact finds the matching platform and errors clearly otherwise", () => {
  const manifest = {
    manifestVersion: 2,
    runtimeVersion: "1.0.0",
    releaseRepository: "local/test",
    releaseTag: "agenc-v1.0.0",
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        runtimeVersion: "1.0.0",
        ...compatibilityFields("linux"),
        url: LOCAL_RUNTIME_URL,
        sha256: "a".repeat(64),
        bytes: 1,
        bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
      },
      {
        platform: "darwin",
        arch: "arm64",
        runtimeVersion: "1.0.0",
        ...compatibilityFields("darwin"),
        url: LOCAL_RUNTIME_URL,
        sha256: "b".repeat(64),
        bytes: 1,
        bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
      },
    ],
  };
  assert.equal(
    selectArtifact(
      manifest,
      { os: "darwin", arch: "arm64" },
      process.versions.modules,
      {
        ...HOST_RUNTIME,
        platform: "darwin",
        arch: "arm64",
        macosVersion: "14.0",
      },
      LOCAL_SELECT_OPTIONS,
    ).sha256,
    "b".repeat(64),
  );
  assert.throws(
    () => selectArtifact(
      manifest,
      { os: "win", arch: "x64" },
      process.versions.modules,
      HOST_RUNTIME,
      LOCAL_SELECT_OPTIONS,
    ),
    new RegExp(`no runtime build for win-x64\\/abi${process.versions.modules}`),
  );
  assert.throws(
    () => selectArtifact(
      manifest,
      { os: "linux", arch: "x64" },
      "999",
      HOST_RUNTIME,
      LOCAL_SELECT_OPTIONS,
    ),
    /no runtime build for linux-x64\/abi999/,
  );
});

test("selectArtifact rejects incompatible Linux libc before download", () => {
  const artifact = {
    platform: "linux",
    arch: "x64",
    runtimeVersion: "1.0.0",
    ...compatibilityFields("linux"),
    url: LOCAL_RUNTIME_URL,
    sha256: "a".repeat(64),
    bytes: 1,
    bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
  };
  const manifest = {
    manifestVersion: 2,
    runtimeVersion: "1.0.0",
    releaseRepository: "local/test",
    releaseTag: "agenc-v1.0.0",
    artifacts: [artifact],
  };
  const base = {
    platform: "linux",
    arch: "x64",
    nodeMajor: NODE_MAJOR,
    nodeModuleAbi: process.versions.modules,
    glibcxxVersion: "3.4.25",
    cxxAbiVersion: "1.3.11",
  };
  assert.throws(
    () => selectArtifact(manifest, { os: "linux", arch: "x64" }, process.versions.modules, {
      ...base,
      libcFamily: "unknown",
    }, LOCAL_SELECT_OPTIONS),
    /requires glibc/,
  );
  assert.throws(
    () => selectArtifact(manifest, { os: "linux", arch: "x64" }, process.versions.modules, {
      ...base,
      libcFamily: "glibc",
      glibcVersion: "2.27",
    }, LOCAL_SELECT_OPTIONS),
    /requires glibc 2\.28/,
  );
  assert.equal(
    selectArtifact(manifest, { os: "linux", arch: "x64" }, process.versions.modules, {
      ...base,
      libcFamily: "glibc",
      glibcVersion: "2.28",
    }, LOCAL_SELECT_OPTIONS),
    artifact,
  );
  assert.throws(
    () => selectArtifact(manifest, { os: "linux", arch: "x64" }, process.versions.modules, {
      ...base,
      libcFamily: "glibc",
      glibcVersion: "2.9",
    }, LOCAL_SELECT_OPTIONS),
    /requires glibc 2\.28/,
  );
});

test("runtime cache keys isolate same-ABI platform artifacts", () => {
  const home = "/tmp/agenc-home";
  const linux = {
    platform: "linux",
    arch: "x64",
    nodeModuleAbi: process.versions.modules,
    libcFamily: "glibc",
  };
  const darwin = {
    platform: "darwin",
    arch: "x64",
    nodeModuleAbi: process.versions.modules,
  };
  assert.notEqual(
    runtimeInstallDir(home, "1.0.0", linux),
    runtimeInstallDir(home, "1.0.0", darwin),
  );
  assert.match(runtimeInstallDir(home, "1.0.0", linux), /linux-x64-glibc-node-abi-/);
});

test("runtime archive validation rejects traversal and escaping links", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-archive-validation-"));
  try {
    const traversal = join(work, "traversal.tar.gz");
    writeFileSync(traversal, rawTarWithMember("../escape"));
    assert.throws(() => validateRuntimeArchive(traversal), /unsafe runtime archive path/);
    const link = join(work, "link.tar.gz");
    writeFileSync(
      link,
      rawTarWithMember("node_modules/escape", "2", "../../outside"),
    );
    assert.throws(() => validateRuntimeArchive(link), /link escapes node_modules/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runtime archive validation rejects Windows path aliases and case collisions", () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-archive-win-validation-"));
  try {
    for (const [name, path] of [
      ["alternate data stream", "node_modules/pkg/file:stream"],
      ["reserved device", "node_modules/pkg/COM1.txt"],
      ["superscript reserved device", "node_modules/pkg/LPT\u00b9.txt"],
      ["trailing dot", "node_modules/pkg/file."],
      ["raw USTAR trailing space", "node_modules/pkg/file "],
    ]) {
      const archive = join(work, `${name.replaceAll(" ", "-")}.tar.gz`);
      writeFileSync(archive, rawTarWithMember(path));
      assert.throws(
        () => validateRuntimeArchive(archive, "win"),
        /unsafe runtime archive path for win/,
      );
    }
    const collision = join(work, "collision.tar.gz");
    writeFileSync(
      collision,
      rawTarWithMembers([
        ["node_modules/", "5"],
        ["node_modules/Pkg", "5"],
        ["node_modules/pkg", "5"],
      ]),
    );
    assert.throws(
      () => validateRuntimeArchive(collision, "win"),
      /case\/Unicode path collision/,
    );
    const leading = join(work, "raw-ustar-leading-space.tar.gz");
    writeFileSync(
      leading,
      rawTarWithMembers([
        ["node_modules/", "5"],
        [" node_modules/pkg/file"],
      ]),
    );
    assert.throws(
      () => validateRuntimeArchive(leading, "win"),
      /outside node_modules/,
    );
    const linkSpace = join(work, "raw-ustar-link-space.tar.gz");
    writeFileSync(
      linkSpace,
      rawTarWithMembers([
        ["node_modules/", "5"],
        ["node_modules/link", "2", "./target "],
      ]),
    );
    assert.throws(
      () => validateRuntimeArchive(linkSpace, "win"),
      /unsafe runtime archive link target for win/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
    const { artifact, sha256: digest, bytes } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const manifest = {
      manifestVersion: 2,
      runtimeVersion: version,
      releaseRepository: "local/test",
      releaseTag: `agenc-v${version}`,
      artifacts: [
        {
          platform: platformSlug().os,
          arch: platformSlug().arch,
          runtimeVersion: version,
          nodeMajor: Number(process.versions.node.split(".")[0]),
          nodeModuleAbi: process.versions.modules,
          nodeApiVersion: process.versions.napi,
          ...compatibilityFields(platformSlug().os),
          url: pathToFileURL(artifact).href,
          sha256: digest,
          bytes,
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        },
      ],
    };

    const logs = [];
    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: (m) => logs.push(m),
      runtimeCompatibility: HOST_RUNTIME,
    });
    assert.equal(bin, runtimeBinPath(home, version, manifest.artifacts[0]));
    assert.ok(existsSync(bin), "runtime bin should be extracted");
    assert.ok(isInstalled(runtimeInstallDir(home, version, manifest.artifacts[0]), digest));
    assert.match(bin, /node-abi-[0-9]+/);
    assert.ok(logs.some((l) => l.includes("fetching")));

    // Second call short-circuits: no "fetching" log this time.
    const logs2 = [];
    const bin2 = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: (m) => logs2.push(m),
      runtimeCompatibility: HOST_RUNTIME,
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

test("ensureRuntime repairs a pre-hardening group-writable runtime dir instead of failing", {
  skip: process.platform === "win32",
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-perm-repair-"));
  try {
    const version = "9.9.9";
    const { artifact, sha256: digest, bytes } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    // Model an install created by an old launcher under umask 002: the
    // intermediate runtime dir exists and is group-writable. Before the
    // repair walk this made every ensureRuntime call fail the
    // private-directory assertion with "permits untrusted mutation".
    const runtimeDir = join(home, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    chmodSync(home, 0o700);
    chmodSync(runtimeDir, 0o770);
    const manifest = {
      manifestVersion: 2,
      runtimeVersion: version,
      releaseRepository: "local/test",
      releaseTag: `agenc-v${version}`,
      artifacts: [
        {
          platform: platformSlug().os,
          arch: platformSlug().arch,
          runtimeVersion: version,
          nodeMajor: Number(process.versions.node.split(".")[0]),
          nodeModuleAbi: process.versions.modules,
          nodeApiVersion: process.versions.napi,
          ...compatibilityFields(platformSlug().os),
          url: pathToFileURL(artifact).href,
          sha256: digest,
          bytes,
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        },
      ],
    };

    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });
    assert.ok(existsSync(bin), "runtime bin should be extracted");
    const repairedMode = statSync(runtimeDir).mode & 0o777;
    assert.equal(
      repairedMode,
      0o700,
      `runtime dir should be repaired to 0700, got 0${repairedMode.toString(8)}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runtime extraction ignores project PATH and tar environment controls", {
  skip: process.platform === "win32",
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-trusted-tar-"));
  const priorPath = process.env.PATH;
  const priorTarOptions = process.env.TAR_OPTIONS;
  try {
    const version = "9.9.10";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const hostileBin = join(work, "node_modules", ".bin");
    const sentinel = join(work, "ambient-tar-executed");
    mkdirSync(hostileBin, { recursive: true });
    const hostileTar = join(hostileBin, "tar");
    writeFileSync(
      hostileTar,
      `#!/bin/sh\nprintf 'ambient tar executed\\n' > ${JSON.stringify(sentinel)}\nexit 97\n`,
    );
    chmodSync(hostileTar, 0o755);
    process.env.PATH = `${hostileBin}:${priorPath ?? ""}`;
    process.env.TAR_OPTIONS = "--agenc-hostile-option-must-not-be-read";

    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: join(work, "home") },
      manifest,
      runtimeCompatibility: HOST_RUNTIME,
      log: () => {},
    });

    assert.ok(existsSync(bin));
    assert.equal(existsSync(sentinel), false, "ambient tar must never execute");
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorTarOptions === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = priorTarOptions;
    rmSync(work, { recursive: true, force: true });
  }
});

test("runtime downloads never traverse a retargetable ambient TMPDIR", {
  skip: process.platform === "win32",
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-private-download-root-"));
  const priorTmpdir = process.env.TMPDIR;
  try {
    const version = "9.9.11";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const firstTarget = join(work, "ambient-target-one");
    const secondTarget = join(work, "ambient-target-two");
    const ambientAlias = join(work, "ambient-tmp-alias");
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    writeFileSync(join(firstTarget, "sentinel"), "one\n");
    writeFileSync(join(secondTarget, "sentinel"), "two\n");
    symlinkSync(firstTarget, ambientAlias, "dir");
    process.env.TMPDIR = ambientAlias;
    let retargeted = false;

    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: join(work, "home") },
      manifest,
      runtimeCompatibility: HOST_RUNTIME,
      log: () => {},
      durabilityHook(event) {
        if (event !== "sync-download" || retargeted) return;
        unlinkSync(ambientAlias);
        symlinkSync(secondTarget, ambientAlias, "dir");
        retargeted = true;
      },
    });

    assert.ok(existsSync(bin));
    assert.equal(retargeted, true);
    assert.deepEqual(readdirSync(firstTarget), ["sentinel"]);
    assert.deepEqual(readdirSync(secondTarget), ["sentinel"]);
  } finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
    rmSync(work, { recursive: true, force: true });
  }
});

test("local artifact open rejects an lstat-to-open path swap", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-swap-open-"));
  try {
    const version = "9.8.1";
    const built = makeSyntheticArtifact(work, version);
    const originalBytes = readFileSync(built.artifact);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const home = join(work, "home");
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
        localArtifactHook(stage, { path }) {
          if (stage !== "after-lstat") return;
          renameSync(path, `${path}.original`);
          writeFileSync(path, Buffer.alloc(originalBytes.length, 0x61));
        },
      }),
      /local runtime artifact changed while it was opened/,
    );
    assert.equal(
      existsSync(runtimeInstallDir(home, version, manifest.artifacts[0])),
      false,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("local artifact EOF validation rejects a path swap after descriptor open", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-swap-read-"));
  try {
    const version = "9.8.2";
    const built = makeSyntheticArtifact(work, version);
    const bytes = readFileSync(built.artifact);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
        localArtifactHook(stage, { path }) {
          if (stage !== "after-open") return;
          renameSync(path, `${path}.opened`);
          writeFileSync(path, bytes);
        },
      }),
      /local runtime artifact changed while it was read/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("local artifact EOF validation rejects mutation and closes its descriptor", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-mutation-"));
  try {
    const version = "9.8.3";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
        localArtifactHook(stage, { path }) {
          if (stage === "before-eof-validation") appendFileSync(path, "x");
        },
      }),
      /runtime byte count mismatch|local runtime artifact changed while it was read/,
    );
    // This is particularly meaningful on Windows, where rename fails while a
    // descriptor was accidentally left open.
    renameSync(built.artifact, `${built.artifact}.closed`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("local artifacts reject hard-link aliases", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-hardlink-"));
  try {
    const version = "9.8.4";
    const built = makeSyntheticArtifact(work, version);
    const linked = join(work, "runtime-hardlink.tar.gz");
    linkSync(built.artifact, linked);
    const manifest = syntheticManifest(version, linked, built.sha256, built.bytes);
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
      }),
      /plain single-link file/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("local artifacts reject symlinks before opening", {
  skip: process.platform === "win32",
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-local-symlink-"));
  try {
    const version = "9.8.5";
    const built = makeSyntheticArtifact(work, version);
    const linked = join(work, "runtime-symlink.tar.gz");
    symlinkSync(built.artifact, linked);
    const manifest = syntheticManifest(version, linked, built.sha256, built.bytes);
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
      }),
      /plain single-link file/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runtime promotion flushes download, marker, extracted tree, and parent in order", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-durable-order-"));
  try {
    const version = "9.8.6";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const events = [];
    await ensureLocalRuntime({
      env: { AGENC_HOME: join(work, "home") },
      manifest,
      runtimeCompatibility: HOST_RUNTIME,
      log: () => {},
      durabilityHook(event, details) { events.push({ event, ...details }); },
    });
    const names = events.map(({ event }) => event);
    const renameIndex = names.indexOf("rename-stage-to-current");
    const parentBarrier = process.platform === "win32"
      ? "verify-sync-parent-after-rename"
      : "sync-parent-after-rename";
    const treeBarrier = process.platform === "win32"
      ? "verify-sync-tree-directory"
      : "sync-tree-directory";
    const removalBarrier = process.platform === "win32"
      ? "verify-sync-parent-after-remove"
      : "sync-parent-after-remove";
    assert.ok(names.indexOf("sync-download") < names.indexOf("sync-marker"));
    assert.ok(names.indexOf("sync-marker") < renameIndex);
    assert.ok(names.lastIndexOf("sync-tree-file") < renameIndex);
    assert.ok(names.lastIndexOf(treeBarrier) < renameIndex);
    assert.ok(renameIndex < names.indexOf(parentBarrier, renameIndex));
    const temporaryRemoval = names.lastIndexOf("remove-temporary");
    assert.ok(renameIndex < temporaryRemoval);
    assert.ok(temporaryRemoval < names.indexOf(removalBarrier, temporaryRemoval));
    const syncedFiles = events
      .filter(({ event }) => event === "sync-tree-file")
      .map(({ path }) => path);
    assert.ok(syncedFiles.some((path) => path.endsWith(".agenc-runtime-ok")));
    assert.ok(syncedFiles.some((path) => path.endsWith(join("bin", "agenc"))));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("durability barrier failures before promotion leave no canonical install", async () => {
  for (const failedEvent of ["sync-download", "sync-marker", "sync-tree-file"]) {
    const work = mkdtempSync(join(tmpdir(), `agenc-durable-fault-${failedEvent}-`));
    try {
      const version = failedEvent === "sync-download"
        ? "9.8.7"
        : failedEvent === "sync-marker" ? "9.8.8" : "9.8.9";
      const built = makeSyntheticArtifact(work, version);
      const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
      const home = join(work, "home");
      await assert.rejects(
        ensureLocalRuntime({
          env: { AGENC_HOME: home },
          manifest,
          runtimeCompatibility: HOST_RUNTIME,
          log: () => {},
          durabilityHook(event) {
            if (event === failedEvent) throw new Error(`injected ${failedEvent} failure`);
          },
        }),
        new RegExp(`injected ${failedEvent} failure`),
      );
      assert.equal(
        existsSync(runtimeInstallDir(home, version, manifest.artifacts[0])),
        false,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("a parent-directory barrier fault after rename is reported and recoverable", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-durable-parent-fault-"));
  try {
    const version = "9.8.10";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const home = join(work, "home");
    const parentBarrier = process.platform === "win32"
      ? "verify-sync-parent-after-rename"
      : "sync-parent-after-rename";
    let injected = false;
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
        durabilityHook(event) {
          if (event === parentBarrier && !injected) {
            injected = true;
            throw new Error("injected parent barrier failure");
          }
        },
      }),
      /injected parent barrier failure/,
    );
    const installDir = runtimeInstallDir(home, version, manifest.artifacts[0]);
    assert.equal(isInstalled(installDir, built.sha256), true);
    const recovered = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      runtimeCompatibility: HOST_RUNTIME,
      log: () => {},
    });
    assert.equal(recovered, runtimeBinPath(home, version, manifest.artifacts[0]));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime collapses an existing AGENC_HOME symlink onto its canonical target", {
  skip: process.platform === "win32",
}, async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-home-alias-"));
  try {
    const version = "9.9.8";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const canonicalHome = join(work, "canonical-home");
    const aliasHome = join(work, "home-alias");
    mkdirSync(canonicalHome, { mode: 0o700 });
    symlinkSync(canonicalHome, aliasHome, "dir");

    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: aliasHome },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });

    assert.equal(bin, runtimeBinPath(canonicalHome, version, manifest.artifacts[0]));
    assert.ok(existsSync(bin));
    assert.equal(existsSync(runtimeInstallDir(canonicalHome, version, manifest.artifacts[0])), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime rejects a checksum mismatch", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-badsha-"));
  try {
    const version = "9.9.9";
    const { artifact, bytes } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const manifest = {
      manifestVersion: 2,
      runtimeVersion: version,
      releaseRepository: "local/test",
      releaseTag: `agenc-v${version}`,
      artifacts: [
        {
          platform: platformSlug().os,
          arch: platformSlug().arch,
          runtimeVersion: version,
          nodeMajor: Number(process.versions.node.split(".")[0]),
          nodeModuleAbi: process.versions.modules,
          nodeApiVersion: process.versions.napi,
          ...compatibilityFields(platformSlug().os),
          url: pathToFileURL(artifact).href,
          sha256: "0".repeat(64), // wrong
          bytes,
          bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
        },
      ],
    };
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        log: () => {},
        runtimeCompatibility: HOST_RUNTIME,
      }),
      /checksum mismatch/,
    );
    // Nothing left half-installed.
    assert.equal(
      isInstalled(runtimeInstallDir(home, version, manifest.artifacts[0]), "0".repeat(64)),
      false,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime preserves the operation and every cleanup failure in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-runtime-cleanup-errors-"));
  const home = join(root, "home");
  const tree = join(root, "tree");
  const placeholder = join(tree, "node_modules", "placeholder.txt");
  mkdirSync(dirname(placeholder), { recursive: true });
  writeFileSync(placeholder, "no runtime entrypoint\n");
  const artifactPath = join(root, "runtime.tar.gz");
  assert.equal(
    spawnSync("tar", ["-czf", artifactPath, "-C", tree, "node_modules"]).status,
    0,
  );
  const bytes = readFileSync(artifactPath);
  const manifest = syntheticManifest("8.8.8-test", artifactPath, sha256(bytes), bytes.length);
  const cleanupPaths = [];
  let acquisition = 0;
  try {
    await assert.rejects(
      ensureLocalRuntime({
        env: { AGENC_HOME: home },
        manifest,
        slug: platformSlug(),
        runtimeCompatibility: HOST_RUNTIME,
        acquireLock: async () => {
          acquisition += 1;
          if (acquisition === 1) return () => {};
          return () => { throw new Error("release cleanup failed"); };
        },
        remove: (path) => {
          cleanupPaths.push(path);
          if (basename(path).includes(".install-")) {
            throw new Error("staging cleanup failed");
          }
          throw new Error("download cleanup failed");
        },
        log: () => {},
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "agenc: runtime install and cleanup did not both complete");
        const messages = error.errors.map((entry) => entry.message);
        assert.match(messages[0], /runtime extracted but entry missing/);
        assert.deepEqual(messages.slice(1), [
          "staging cleanup failed",
          "release cleanup failed",
          "download cleanup failed",
        ]);
        return true;
      },
    );
  } finally {
    for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRuntime rejects an HTTPS-to-HTTP artifact redirect", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-downgrade-redirect-"));
  let cancelled = false;
  let signal;
  try {
    const version = "9.9.9";
    const selected = {
      platform: platformSlug().os,
      arch: platformSlug().arch,
      runtimeVersion: version,
      nodeMajor: Number(process.versions.node.split(".")[0]),
      nodeModuleAbi: process.versions.modules,
      nodeApiVersion: process.versions.napi,
      ...compatibilityFields(platformSlug().os),
      url:
        `https://github.com/test/releases/releases/download/agenc-v${version}/` +
        `agenc-runtime-${version}-${platformSlug().os}-${platformSlug().arch}` +
        `-node${NODE_MAJOR}-abi${process.versions.modules}.tar.gz`,
      sha256: "0".repeat(64),
      bytes: 1,
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    };
    await assert.rejects(
      ensureRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest: {
          manifestVersion: 2,
          runtimeVersion: version,
          releaseRepository: "test/releases",
          releaseTag: `agenc-v${version}`,
          build: {
            sourceCommit: "a".repeat(40),
            sourceRef: `refs/tags/agenc-v${version}`,
            sourceDateEpoch: 1,
            lockfileSha256: "d".repeat(64),
            nodeVersion: `v${NODE_MAJOR}.0.0`,
            nodeMajor: NODE_MAJOR,
            nodeModuleAbi: process.versions.modules,
            nodeApiVersion: process.versions.napi,
            npmVersion: "11.17.0",
            artifactProfile: "release",
          },
          artifacts: [selected],
        },
        manifestTrust: "explicitHttps",
        log: () => {},
        runtimeCompatibility: HOST_RUNTIME,
        fetchImpl: async (_url, options) => {
          signal = options.signal;
          return ({
          status: 302,
          headers: { get: () => "http://example.invalid/runtime.tar.gz" },
          body: { cancel: async () => { cancelled = true; } },
          });
        },
      }),
      /refusing HTTPS downgrade/,
    );
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("HTTPS download aborts on the first byte above the signed size and cleans partial state", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-bounded-download-over-"));
  const home = join(work, "home");
  let cancelled = false;
  let downloadDirectory;
  try {
    const manifest = httpsManifest("7.7.7", "a".repeat(64), 1);
    const url = manifest.artifacts[0].url;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x61, 0x62));
      },
      cancel() { cancelled = true; },
    });
    await assert.rejects(
      ensureRuntime({
        env: { AGENC_HOME: home },
        manifest,
        manifestTrust: "explicitHttps",
        runtimeCompatibility: HOST_RUNTIME,
        log: () => {},
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          redirected: false,
          url,
          headers: { get: () => null },
          body,
        }),
        remove(path, options) {
          if (basename(path).startsWith(".agenc-runtime-download-")) {
            downloadDirectory = path;
          }
          rmSync(path, options);
        },
      }),
      /byte count exceeds signed size.*expected 1, received at least 2/,
    );
    assert.equal(cancelled, true);
    assert.equal(typeof downloadDirectory, "string");
    assert.equal(existsSync(downloadDirectory), false);
    assert.equal(
      existsSync(runtimeInstallDir(home, "7.7.7", manifest.artifacts[0])),
      false,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("HTTPS download rejects short bodies and mismatched Content-Length", async () => {
  const cases = [
    {
      label: "short body",
      contentLength: null,
      chunks: [Uint8Array.of(0x61)],
      expected: /byte count mismatch \(expected 2, got 1\)/,
    },
    {
      label: "detached Content-Length",
      contentLength: "3",
      chunks: [Uint8Array.of(0x61)],
      expected: /Content-Length mismatch \(expected 2, got 3\)/,
    },
  ];
  for (const fixture of cases) {
    const work = mkdtempSync(join(tmpdir(), "agenc-bounded-download-short-"));
    const home = join(work, "home");
    let cancelled = false;
    let pulled = 0;
    try {
      const manifest = httpsManifest("7.7.8", "a".repeat(64), 2);
      const url = manifest.artifacts[0].url;
      const queue = [...fixture.chunks];
      const body = new ReadableStream({
        pull(controller) {
          pulled += 1;
          const chunk = queue.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      });
      await assert.rejects(
        ensureRuntime({
          env: { AGENC_HOME: home },
          manifest,
          manifestTrust: "explicitHttps",
          runtimeCompatibility: HOST_RUNTIME,
          log: () => {},
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            redirected: false,
            url,
            headers: {
              get(name) {
                return name === "content-length" ? fixture.contentLength : null;
              },
            },
            body,
          }),
        }),
        fixture.expected,
        fixture.label,
      );
      assert.equal(
        existsSync(runtimeInstallDir(home, "7.7.8", manifest.artifacts[0])),
        false,
      );
      if (fixture.contentLength !== null) {
        assert.equal(cancelled, true, fixture.label);
        assert.equal(pulled <= 1, true, `${fixture.label} body must not be consumed`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test("one runtime fetch deadline aborts a stalled response-header wait", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-fetch-header-timeout-"));
  let signal;
  const started = performance.now();
  try {
    const manifest = httpsManifest("7.6.1", "a".repeat(64), 1);
    await assert.rejects(
      ensureRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        manifestTrust: "explicitHttps",
        runtimeCompatibility: HOST_RUNTIME,
        runtimeFetchTimeoutMs: 30,
        log: () => {},
        fetchImpl(_url, options) {
          signal = options.signal;
          return new Promise(() => {});
        },
      }),
      /runtime artifact response headers timed out after 30 ms total/,
    );
    assert.equal(signal.aborted, true);
    assert.ok(performance.now() - started < 500, "stalled headers exceeded the total budget");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("one runtime fetch deadline aborts and cancels a stalled body read", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-fetch-body-timeout-"));
  let signal;
  let cancelled = false;
  try {
    const manifest = httpsManifest("7.6.2", "a".repeat(64), 1);
    const url = manifest.artifacts[0].url;
    const body = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(
      ensureRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        manifestTrust: "explicitHttps",
        runtimeCompatibility: HOST_RUNTIME,
        runtimeFetchTimeoutMs: 35,
        log: () => {},
        fetchImpl: async (_requested, options) => {
          signal = options.signal;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            redirected: false,
            url,
            headers: { get: () => null },
            body,
          };
        },
      }),
      /runtime artifact (?:response body|download) timed out after 35 ms total/,
    );
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("redirects and headers consume one shared runtime fetch budget", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-fetch-redirect-budget-"));
  let calls = 0;
  let cancellations = 0;
  let signal;
  const started = performance.now();
  try {
    const manifest = httpsManifest("7.6.3", "a".repeat(64), 1);
    await assert.rejects(
      ensureRuntime({
        env: { AGENC_HOME: join(work, "home") },
        manifest,
        manifestTrust: "explicitHttps",
        runtimeCompatibility: HOST_RUNTIME,
        runtimeFetchTimeoutMs: 75,
        log: () => {},
        async fetchImpl(_requested, options) {
          signal = options.signal;
          calls += 1;
          await delay(35);
          return {
            status: 302,
            headers: {
              get(name) {
                return name === "location"
                  ? `https://objects.example.invalid/redirect-${calls}`
                  : null;
              },
            },
            body: { cancel: async () => { cancellations += 1; } },
          };
        },
      }),
      /runtime artifact response headers timed out after 75 ms total/,
    );
    assert.equal(calls, 3, "each redirect received a fresh timeout budget");
    assert.equal(cancellations, 2, "completed redirect bodies were not cancelled");
    assert.equal(signal.aborted, true);
    assert.ok(performance.now() - started < 160, "redirects multiplied the timeout budget");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime repairs a stale marker whose runtime bin is missing", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-stale-marker-"));
  try {
    const version = "9.9.9";
    const { artifact, sha256: digest, bytes } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const selected = {
      platform: platformSlug().os,
      arch: platformSlug().arch,
      runtimeVersion: version,
      ...compatibilityFields(platformSlug().os),
      url: pathToFileURL(artifact).href,
      sha256: digest,
      bytes,
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    };
    const manifest = {
      manifestVersion: 2,
      runtimeVersion: version,
      releaseRepository: "local/test",
      releaseTag: `agenc-v${version}`,
      artifacts: [selected],
    };
    const first = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });
    rmSync(first);
    const second = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });
    assert.equal(second, first);
    assert.ok(existsSync(second));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("concurrent runtime installs converge without partial trees", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-concurrent-install-"));
  try {
    const version = "9.9.9";
    const { artifact, sha256: digest, bytes } = makeSyntheticArtifact(work, version);
    const home = join(work, "home");
    const selected = {
      platform: platformSlug().os,
      arch: platformSlug().arch,
      runtimeVersion: version,
      ...compatibilityFields(platformSlug().os),
      url: pathToFileURL(artifact).href,
      sha256: digest,
      bytes,
      bins: { agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc" },
    };
    const manifest = {
      manifestVersion: 2,
      runtimeVersion: version,
      releaseRepository: "local/test",
      releaseTag: `agenc-v${version}`,
      artifacts: [selected],
    };
    const options = {
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    };
    const [first, second] = await Promise.all([
      ensureLocalRuntime(options),
      ensureLocalRuntime(options),
    ]);
    assert.equal(first, second);
    assert.ok(existsSync(first));
    assert.ok(
      isInstalled(runtimeInstallDir(home, version, selected), digest, first),
    );
    const versionDir = dirname(runtimeInstallDir(home, version, selected));
    assert.equal(
      readdirSync(versionDir).some((name) => name.includes(".install-") || name.endsWith(".lock")),
      false,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime restores a verified backup before network I/O", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-offline-backup-recovery-"));
  try {
    const version = "9.9.10";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const selected = manifest.artifacts[0];
    const home = join(work, "home");
    const options = {
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    };
    const bin = await ensureLocalRuntime(options);
    const installDir = runtimeInstallDir(home, version, selected);
    const backup = `${installDir}.old-crash-before-stage-rename`;
    renameSync(installDir, backup);
    rmSync(built.artifact);

    assert.equal(await ensureLocalRuntime(options), bin);
    assert.ok(existsSync(bin));
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime promotes a verified stage before an invalid canonical tree offline", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-offline-stage-recovery-"));
  try {
    const version = "9.9.11";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const selected = manifest.artifacts[0];
    const home = join(work, "home");
    const options = {
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    };
    const bin = await ensureLocalRuntime(options);
    const installDir = runtimeInstallDir(home, version, selected);
    const stage = join(dirname(installDir), `.${basename(installDir)}.install-crash`);
    renameSync(installDir, stage);
    mkdirSync(installDir);
    writeFileSync(join(installDir, ".agenc-runtime-ok"), "invalid");
    rmSync(built.artifact);

    assert.equal(await ensureLocalRuntime(options), bin);
    assert.ok(existsSync(bin));
    assert.equal(existsSync(stage), false);
    assert.deepEqual(
      readdirSync(dirname(installDir)).filter((name) => name.includes(".old-") || name.includes(".install-")),
      [],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ensureRuntime prefers the prepared stage and cleans post-promotion residue", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-stage-precedence-"));
  try {
    const version = "9.9.12";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const selected = manifest.artifacts[0];
    const home = join(work, "home");
    const options = {
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    };
    const bin = await ensureLocalRuntime(options);
    const installDir = runtimeInstallDir(home, version, selected);
    const base = basename(installDir);
    const backup = `${installDir}.old-ready`;
    const stage = join(dirname(installDir), `.${base}.install-ready`);
    cpSync(installDir, backup, { recursive: true });
    cpSync(installDir, stage, { recursive: true });
    writeFileSync(join(stage, selected.bins.agenc), "prepared-stage\n");
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(installDir);
    writeFileSync(join(installDir, ".agenc-runtime-ok"), "invalid");
    rmSync(built.artifact);

    await ensureLocalRuntime(options);
    assert.equal(readFileSync(bin, "utf8"), "prepared-stage\n");
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("same-version artifacts with different digests install side by side", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-content-addressed-"));
  try {
    const version = "9.9.13";
    const firstDir = join(work, "first");
    const secondDir = join(work, "second");
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const first = makeSyntheticArtifact(firstDir, version, "#!/usr/bin/env node\nconsole.log('first')\n");
    const second = makeSyntheticArtifact(secondDir, version, "#!/usr/bin/env node\nconsole.log('second')\n");
    assert.notEqual(first.sha256, second.sha256);
    const firstManifest = syntheticManifest(version, first.artifact, first.sha256, first.bytes);
    const secondManifest = syntheticManifest(version, second.artifact, second.sha256, second.bytes);
    const home = join(work, "home");
    const firstBin = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest: firstManifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });
    const secondBin = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest: secondManifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });

    assert.notEqual(dirname(dirname(dirname(dirname(firstBin)))), dirname(dirname(dirname(dirname(secondBin)))));
    assert.match(readFileSync(firstBin, "utf8"), /first/);
    assert.match(readFileSync(secondBin, "utf8"), /second/);
    assert.ok(existsSync(runtimeInstallDir(home, version, firstManifest.artifacts[0])));
    assert.ok(existsSync(runtimeInstallDir(home, version, secondManifest.artifacts[0])));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("isInstalled rejects a symlinked marker even when its bytes match", async () => {
  const work = mkdtempSync(join(tmpdir(), "agenc-strict-marker-"));
  try {
    const version = "9.9.14";
    const built = makeSyntheticArtifact(work, version);
    const manifest = syntheticManifest(version, built.artifact, built.sha256, built.bytes);
    const selected = manifest.artifacts[0];
    const home = join(work, "home");
    const bin = await ensureLocalRuntime({
      env: { AGENC_HOME: home },
      manifest,
      log: () => {},
      runtimeCompatibility: HOST_RUNTIME,
    });
    const installDir = runtimeInstallDir(home, version, selected);
    const marker = join(installDir, ".agenc-runtime-ok");
    const externalMarker = join(work, "matching-marker");
    writeFileSync(externalMarker, built.sha256);
    rmSync(marker);
    symlinkSync(externalMarker, marker);

    assert.equal(isInstalled(installDir, built.sha256, bin), false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
