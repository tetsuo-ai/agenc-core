import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ensureRuntimeInstalled,
  loadVerifiedManifest,
  uninstallRuntime,
} from "../lib/runtime-manager.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function createFixtureContext(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenc-wrapper-test."));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const packageRoot = path.join(root, "package");
  const generatedDir = path.join(packageRoot, "generated");
  const homeDir = path.join(root, "home");
  await mkdir(generatedDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@tetsuo-ai/agenc", version: "0.1.0" }, null, 2),
    "utf8",
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(
    path.join(generatedDir, "agenc-runtime-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );

  return {
    packageRoot,
    homeDir,
    async stageEmbeddedRelease(runtimeVersion, artifactTargets = [{ platform: "linux", arch: "x64" }]) {
      const artifactStageDir = path.join(root, `artifact-stage-${runtimeVersion}`);
      const runtimeBinDir = path.join(
        artifactStageDir,
        "node_modules",
        "@tetsuo-ai",
        "runtime",
        "dist",
        "bin",
      );
      await mkdir(runtimeBinDir, { recursive: true });

      const fakeBins = {
        agenc: `#!/usr/bin/env node\nconsole.log("agenc-bin:${runtimeVersion}");\n`,
        "agenc-runtime": `#!/usr/bin/env node\nconsole.log("agenc-runtime-bin:${runtimeVersion}");\n`,
        daemon: `#!/usr/bin/env node\nconsole.log("daemon-bin:${runtimeVersion}");\n`,
        "agenc-watch": `#!/usr/bin/env node\nconsole.log("agenc-watch-bin:${runtimeVersion}");\n`,
      };

      for (const [name, contents] of Object.entries(fakeBins)) {
        await writeFile(path.join(runtimeBinDir, `${name}.js`), contents, {
          encoding: "utf8",
          mode: 0o755,
        });
      }

      const artifacts = [];
      const artifactPaths = [];
      for (const { platform, arch } of artifactTargets) {
        const platformArch = `${platform}-${arch}`;
        const artifactPath = path.join(
          root,
          `agenc-runtime-${runtimeVersion}-${platformArch}.tar.gz`,
        );
        execFileSync("tar", ["-czf", artifactPath, "-C", artifactStageDir, "."], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const artifactSha = sha256(await readFile(artifactPath));
        artifactPaths.push(artifactPath);
        artifacts.push({
          platform,
          arch,
          nodeRange: ">=18.0.0",
          runtimeVersion,
          url: pathToFileURL(artifactPath).href,
          sha256: artifactSha,
          bins: {
            agenc: "node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
            "agenc-runtime":
              "node_modules/@tetsuo-ai/runtime/dist/bin/agenc-runtime.js",
            daemon: "node_modules/@tetsuo-ai/runtime/dist/bin/daemon.js",
            "agenc-watch":
              "node_modules/@tetsuo-ai/runtime/dist/bin/agenc-watch.js",
          },
        });
      }

      const manifest = {
        manifestVersion: 1,
        wrapperVersion: "0.1.0",
        keyId: "local-dev",
        artifacts,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const signature = sign(null, manifestBytes, privateKey).toString("base64");

      await writeFile(
        path.join(generatedDir, "agenc-runtime-manifest.json"),
        manifestBytes,
      );
      await writeFile(
        path.join(generatedDir, "agenc-runtime-manifest.json.sig"),
        `${signature}\n`,
        "utf8",
      );
      await writeFile(
        path.join(generatedDir, "agenc-runtime-trust-policy.json"),
        `${JSON.stringify(
          {
            wrapperVersion: "0.1.0",
            keyId: "local-dev",
            revokedManifestDigests: [],
            revokedRuntimeVersions: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      return { artifactPath: artifactPaths[0], artifactPaths, runtimeVersion };
    },
  };
}

test("loadVerifiedManifest accepts embedded signed manifests", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");

  const loaded = await loadVerifiedManifest({
    packageRoot: fixture.packageRoot,
  });

  assert.ok(loaded);
  assert.equal(loaded.manifest.wrapperVersion, "0.1.0");
  assert.equal(loaded.manifest.keyId, "local-dev");
  assert.equal(loaded.trustPolicy.keyId, "local-dev");
});

test("ensureRuntimeInstalled installs the runtime artifact under ~/.agenc/runtime", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");

  const installed = await ensureRuntimeInstalled({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.0.0",
  });

  await stat(installed.bins.agenc);
  await stat(installed.bins["agenc-runtime"]);
  await stat(path.join(installed.currentDir, "agenc-runtime-installation.json"));
  assert.match(installed.releaseDir, /releases\/0\.1\.0\/linux-x64$/u);
  assert.equal(
    await readlink(installed.currentDir),
    installed.releaseDir,
  );
  assert.ok(installed.bins.agenc.startsWith(installed.currentDir));
});

test("ensureRuntimeInstalled selects darwin-arm64 from a multi-artifact manifest", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0", [
    { platform: "linux", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
  ]);

  const installed = await ensureRuntimeInstalled({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "20.0.0",
  });

  await stat(installed.bins.agenc);
  await stat(installed.bins["agenc-runtime"]);
  assert.equal(installed.selectedArtifact.platform, "darwin");
  assert.equal(installed.selectedArtifact.arch, "arm64");
  assert.match(installed.releaseDir, /releases\/0\.1\.0\/darwin-arm64$/u);
  assert.equal(await readlink(installed.currentDir), installed.releaseDir);
});

test("ensureRuntimeInstalled force=true advances the stable current pointer on upgrade", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");

  const installedV1 = await ensureRuntimeInstalled({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.0.0",
  });
  const currentTargetV1 = await readlink(installedV1.currentDir);
  const installStatePath = path.join(
    fixture.homeDir,
    ".agenc",
    "runtime",
    "install-state.json",
  );
  const installStateV1 = JSON.parse(await readFile(installStatePath, "utf8"));

  await fixture.stageEmbeddedRelease("0.1.1");

  const installedV2 = await ensureRuntimeInstalled({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.0.0",
    force: true,
  });
  const currentTargetV2 = await readlink(installedV2.currentDir);
  const installStateV2 = JSON.parse(await readFile(installStatePath, "utf8"));

  assert.equal(installStateV1.runtimeVersion, "0.1.0");
  assert.equal(installStateV2.runtimeVersion, "0.1.1");
  assert.notEqual(currentTargetV1, currentTargetV2);
  assert.equal(currentTargetV2, installedV2.releaseDir);
  assert.match(installedV2.releaseDir, /releases\/0\.1\.1\/linux-x64$/u);
  await stat(installedV1.releaseDir);
  await stat(installedV2.releaseDir);
  await stat(installedV2.bins.agenc);
  assert.ok(installedV2.bins.agenc.startsWith(installedV2.currentDir));
});

test("uninstallRuntime refuses to remove a live runtime without --force", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");
  const operatorHome = path.join(fixture.homeDir, ".agenc");
  await mkdir(operatorHome, { recursive: true });
  await writeFile(
    path.join(operatorHome, "daemon.pid"),
    JSON.stringify({
      pid: process.pid,
      port: 3100,
      configPath: path.join(operatorHome, "config.json"),
    }),
    "utf8",
  );

  await assert.rejects(
    uninstallRuntime({
      packageRoot: fixture.packageRoot,
      homeDir: fixture.homeDir,
      platform: "linux",
      arch: "x64",
      nodeVersion: "20.0.0",
    }),
    /refusing to uninstall while daemon/u,
  );
});

test("uninstallRuntime removes the installed runtime but preserves operator state", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");

  const installed = await ensureRuntimeInstalled({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.0.0",
  });

  const result = await uninstallRuntime({
    packageRoot: fixture.packageRoot,
    homeDir: fixture.homeDir,
    platform: "linux",
    arch: "x64",
    nodeVersion: "20.0.0",
    force: true,
  });

  assert.equal(result.removed, true);
  await assert.rejects(stat(installed.releaseDir));
  assert.ok(
    result.preservedPaths.some((entry) => entry.endsWith(path.join(".agenc", "config.json"))),
  );
});

test("loadVerifiedManifest rejects revoked runtime versions", async (t) => {
  const fixture = await createFixtureContext(t);
  await fixture.stageEmbeddedRelease("0.1.0");
  const trustPolicyPath = path.join(
    fixture.packageRoot,
    "generated",
    "agenc-runtime-trust-policy.json",
  );
  await writeFile(
    trustPolicyPath,
    `${JSON.stringify(
      {
        wrapperVersion: "0.1.0",
        keyId: "local-dev",
        revokedManifestDigests: [],
        revokedRuntimeVersions: ["0.1.0"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    loadVerifiedManifest({
      packageRoot: fixture.packageRoot,
    }),
    /runtime version 0\.1\.0 has been revoked/u,
  );
});
