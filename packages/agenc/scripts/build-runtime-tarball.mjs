#!/usr/bin/env node
// Build a self-contained, per-platform runtime artifact for GitHub Releases.
//
// The runtime (@tetsuo-ai/runtime) is NOT published to npm — it ships as a
// platform-specific tarball because it pulls native deps (better-sqlite3,
// node-pty) that must be compiled for the host OS/arch. This script produces
// one such artifact for the CURRENT platform; the release CI matrix runs it on
// each target runner.
//
// Output layout (what the install-side runtime-manager extracts verbatim into
// ~/.agenc/runtime/<version>/):
//
//   node_modules/@tetsuo-ai/runtime/{bin,dist,package.json,README.md}
//   node_modules/<every production dep, natively built for this platform>/...
//
// So the runtime entry after extraction is:
//   <root>/node_modules/@tetsuo-ai/runtime/bin/agenc
//
// Steps: build runtime → `npm pack` it (respects its `files`) → `npm install`
// that tarball with --omit=dev into a staging dir (resolves the prod dep tree
// and compiles native modules for THIS platform) → tar the resulting
// node_modules → emit sha256. Pure npm; no hand-rolled dependency resolution.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolve(__dirname, "..");
const repoRoot = resolve(launcherDir, "..", "..");
const runtimeDir = join(repoRoot, "runtime");

// On Windows, npm/tar-style launchers are .cmd shims that spawnSync cannot
// exec directly (ENOENT surfaces as a null status — exactly the CI matrix
// failure mode). `shell: true` resolves them through cmd.exe; argv here is
// always static, never user input.
const IS_WINDOWS = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: IS_WINDOWS,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status ?? res.signal}): ${cmd} ${args.join(" ")}`,
    );
  }
  return res;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WINDOWS,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `command failed (${res.status ?? res.signal}): ${cmd} ${args.join(" ")}\n${res.stderr ?? ""}`,
    );
  }
  return res.stdout.trim();
}

// node platform/arch → the artifact slug used in filenames + the manifest.
function platformSlug() {
  const os = process.platform === "win32" ? "win" : process.platform; // linux | darwin | win
  const arch = process.arch; // x64 | arm64
  return { os, arch, slug: `${os}-${arch}` };
}

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function main() {
  const runtimePkg = JSON.parse(
    readFileSync(join(runtimeDir, "package.json"), "utf8"),
  );
  const version = runtimePkg.version;
  const { os, arch, slug } = platformSlug();

  const outDir = resolve(
    process.env.AGENC_RELEASE_OUT_DIR ?? join(launcherDir, "release-artifacts"),
  );
  mkdirSync(outDir, { recursive: true });

  const stage = mkdtempSync(join(tmpdir(), "agenc-runtime-build-"));
  try {
    // 1. Build the runtime (produces dist/).
    console.error(`[build] runtime ${version} (${slug})`);
    run("npm", ["run", "build"], { cwd: runtimeDir });

    // 2. Pack the runtime package into a tgz (honors runtime's `files`).
    const packed = capture(
      "npm",
      ["pack", "--silent", "--pack-destination", stage],
      { cwd: runtimeDir },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    const runtimeTgz = join(stage, packed);

    // 3. Install the packed runtime + its PROD deps into the staging dir,
    //    compiling native modules for THIS platform.
    const installRoot = join(stage, "install");
    mkdirSync(installRoot, { recursive: true });
    // A bare package.json so npm installs into install/node_modules.
    // (Written in-process: a `node -e` child with embedded quotes breaks
    // under the Windows shell resolution above.)
    writeFileSync(
      join(installRoot, "package.json"),
      JSON.stringify({
        name: "agenc-runtime-bundle",
        private: true,
        version: "0.0.0",
      }),
    );
    run(
      "npm",
      [
        "install",
        runtimeTgz,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--install-strategy=hoisted",
      ],
      { cwd: installRoot },
    );

    const nodeModules = join(installRoot, "node_modules");
    const runtimeEntry = join(
      nodeModules,
      "@tetsuo-ai",
      "runtime",
      "bin",
      "agenc",
    );
    statSync(runtimeEntry); // hard-fail if the layout isn't what we promise

    // 4. Tar node_modules into the release artifact.
    const artifactName = `agenc-runtime-${version}-${slug}.tar.gz`;
    const artifactPath = join(outDir, artifactName);
    // Windows: bash-on-PATH resolves `tar` to GNU tar, which parses drive
    // letters (D:\...) as remote hosts ("Cannot connect to D:"). The system
    // bsdtar handles Windows paths natively — use it explicitly.
    const tarBin =
      IS_WINDOWS && existsSync("C:\\Windows\\System32\\tar.exe")
        ? "C:\\Windows\\System32\\tar.exe"
        : "tar";
    run(tarBin, ["-czf", artifactPath, "-C", installRoot, "node_modules"]);

    // 5. Hash + report.
    const digest = await sha256(artifactPath);
    const size = statSync(artifactPath).size;
    const meta = {
      platform: os,
      arch,
      runtimeVersion: version,
      artifact: artifactName,
      sha256: digest,
      bytes: size,
      bins: {
        agenc: "node_modules/@tetsuo-ai/runtime/bin/agenc",
      },
    };
    // Sidecar meta so gen-manifest.mjs can assemble the manifest by globbing
    // release-artifacts/ across the CI matrix's downloaded artifacts.
    writeFileSync(
      join(outDir, `${artifactName}.meta.json`),
      JSON.stringify(meta, null, 2),
    );
    // Machine-readable line for CI; human summary on stderr.
    process.stdout.write(JSON.stringify(meta) + "\n");
    console.error(
      `[build] wrote ${artifactPath} (${(size / 1e6).toFixed(1)} MB)\n[build] sha256 ${digest}`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[build] FAILED: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
