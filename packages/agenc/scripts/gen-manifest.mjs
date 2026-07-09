#!/usr/bin/env node
// Assemble generated/agenc-runtime-manifest.json from the per-platform sidecar
// meta files (release-artifacts/*.meta.json) produced by build-runtime-tarball.
//
// In CI the matrix builds each platform on its own runner, uploads the tarball +
// .meta.json as workflow artifacts; this step runs after they're all collected,
// then the manifest is committed into the npm launcher before publish.
//
// Usage:
//   node scripts/gen-manifest.mjs --repo tetsuo-ai/agenc-releases --tag agenc-v0.2.0
//   [--artifacts <dir>]   (default: packages/agenc/release-artifacts)
//   [--base-url <url>]    (override; default: GitHub Releases download URL)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const repo = arg("repo", "tetsuo-ai/agenc-releases");
const tag = arg("tag");
const artifactsDir = resolve(
  arg("artifacts", join(launcherDir, "release-artifacts")),
);
const baseUrl =
  arg("base-url") ??
  (tag ? `https://github.com/${repo}/releases/download/${tag}` : undefined);

if (!tag) {
  console.error("gen-manifest: --tag is required (e.g. agenc-v0.2.0)");
  process.exit(1);
}
if (!existsSync(artifactsDir)) {
  console.error(`gen-manifest: artifacts dir not found: ${artifactsDir}`);
  process.exit(1);
}

const metas = readdirSync(artifactsDir)
  .filter((f) => f.endsWith(".meta.json"))
  .map((f) => JSON.parse(readFileSync(join(artifactsDir, f), "utf8")));

if (metas.length === 0) {
  console.error(`gen-manifest: no *.meta.json in ${artifactsDir}`);
  process.exit(1);
}

const versions = [...new Set(metas.map((m) => m.runtimeVersion))];
if (versions.length !== 1) {
  console.error(`gen-manifest: mixed runtime versions: ${versions.join(", ")}`);
  process.exit(1);
}

const manifest = {
  manifestVersion: 1,
  runtimeVersion: versions[0],
  releaseRepository: repo,
  releaseTag: tag,
  artifacts: metas
    .map((m) => ({
      platform: m.platform,
      arch: m.arch,
      runtimeVersion: m.runtimeVersion,
      url: `${baseUrl}/${m.artifact}`,
      sha256: m.sha256,
      bytes: m.bytes,
      bins: m.bins,
    }))
    .sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`)),
};

const outDir = join(launcherDir, "generated");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "agenc-runtime-manifest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.error(
  `gen-manifest: wrote ${outPath} (${manifest.artifacts.length} platform(s): ${manifest.artifacts
    .map((a) => `${a.platform}-${a.arch}`)
    .join(", ")})`,
);
