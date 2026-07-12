// Install-side runtime resolver for the published launcher.
//
// The npm launcher is tiny; the real runtime is a per-platform tarball on
// GitHub Releases (see scripts/build-runtime-tarball.mjs). This module:
//   1. resolves the already-extracted runtime under <agenc-home>/runtime/<ver>/,
//   2. or, if absent, reads the bundled manifest, downloads the artifact for the
//      current platform, verifies its sha256, and extracts it there.
//
// It is intentionally dependency-free (Node built-ins only) so it can run from
// `postinstall` before anything else is available.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(
  __dirname,
  "..",
  "generated",
  "agenc-runtime-manifest.json",
);

export function resolveAgenCHome(env = process.env, userHome = homedir()) {
  const configured = env.AGENC_HOME?.trim();
  return configured && configured.length > 0
    ? configured
    : join(userHome, ".agenc");
}

export function platformSlug(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "win" : platform;
  return { os, arch };
}

export function readManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `agenc: runtime manifest missing (${manifestPath}); this launcher build is incomplete`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function selectArtifact(manifest, slug = platformSlug()) {
  const match = manifest.artifacts?.find(
    (a) => a.platform === slug.os && a.arch === slug.arch,
  );
  if (!match) {
    const have = (manifest.artifacts ?? [])
      .map((a) => `${a.platform}-${a.arch}`)
      .join(", ");
    throw new Error(
      `agenc: no runtime build for ${slug.os}-${slug.arch} (available: ${have || "none"})`,
    );
  }
  return match;
}

// Directory the artifact extracts to, and the runtime bin inside it.
export function runtimeInstallDir(home, version) {
  return join(home, "runtime", version);
}
export function runtimeBinPath(home, version, artifact) {
  const rel = artifact?.bins?.agenc ?? "node_modules/@tetsuo-ai/runtime/bin/agenc";
  return join(runtimeInstallDir(home, version), rel);
}

function markerPath(installDir) {
  return join(installDir, ".agenc-runtime-ok");
}

// A runtime install is "good" only if the success marker exists AND records the
// expected sha256 — guards against a half-extracted or stale tree.
export function isInstalled(installDir, expectedSha) {
  const marker = markerPath(installDir);
  if (!existsSync(marker)) return false;
  try {
    return readFileSync(marker, "utf8").trim() === expectedSha;
  } catch {
    return false;
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url, dest, fetchImpl = globalThis.fetch) {
  // Local file:// support keeps the whole flow testable without a real release.
  if (url.startsWith("file://")) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(dest));
    return;
  }
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`agenc: download failed ${res.status} ${res.statusText}: ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  try { chmodSync(destDir, 0o700); } catch { /* ignore */ }
  const res = spawnSync("tar", ["-xzf", archive, "-C", destDir], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (res.status !== 0) {
    throw new Error(`agenc: tar extraction failed (status ${res.status ?? res.signal})`);
  }
}

// Ensure the runtime for `manifest.runtimeVersion` is present; returns the bin
// path. Idempotent: a verified existing install short-circuits the download.
export async function ensureRuntime({
  env = process.env,
  userHome = homedir(),
  manifest = readManifest(),
  slug = platformSlug(),
  fetchImpl = globalThis.fetch,
  log = (m) => process.stderr.write(m + "\n"),
} = {}) {
  const home = resolveAgenCHome(env, userHome);
  // Owner-only home (todo-120); install.sh already chmods 700.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    /* ignore */
  }
  const version = manifest.runtimeVersion;
  const artifact = selectArtifact(manifest, slug);
  const installDir = runtimeInstallDir(home, version);

  if (isInstalled(installDir, artifact.sha256)) {
    return runtimeBinPath(home, version, artifact);
  }

  log(`agenc: fetching runtime ${version} (${slug.os}-${slug.arch})...`);
  const tmp = join(tmpdir(), `agenc-runtime-${version}-${process.pid}.tar.gz`);
  try {
    await download(artifact.url, tmp, fetchImpl);
    const actual = await sha256File(tmp);
    if (actual !== artifact.sha256) {
      throw new Error(
        `agenc: runtime checksum mismatch (expected ${artifact.sha256}, got ${actual})`,
      );
    }
    // Replace any partial/old tree atomically-ish: clean then extract.
    rmSync(installDir, { recursive: true, force: true });
    extractTarGz(tmp, installDir);
    const bin = runtimeBinPath(home, version, artifact);
    if (!existsSync(bin)) {
      throw new Error(`agenc: runtime extracted but entry missing: ${bin}`);
    }
    writeFileSync(markerPath(installDir), artifact.sha256);
    log(`agenc: runtime ${version} ready`);
    return bin;
  } finally {
    rmSync(tmp, { force: true });
  }
}
