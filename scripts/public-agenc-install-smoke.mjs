#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapperDir = path.join(repoRoot, "packages", "agenc");
const generatedDir = path.join(wrapperDir, "generated");

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  return {
    keepTemp: argv.includes("--keep-temp"),
    skipBuild: argv.includes("--skip-build"),
  };
}

function runJson(command, args, cwd, env = process.env) {
  return JSON.parse(run(command, args, cwd, env));
}

function readPackedWrapperPackageJson(tarballPath, cwd) {
  return JSON.parse(
    run("tar", ["-xOf", tarballPath, "package/package.json"], cwd),
  );
}

function bumpPatchVersion(version) {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(version);
  if (!match?.groups) {
    throw new Error(`cannot derive next runtime version from ${version}`);
  }
  return `${match.groups.major}.${match.groups.minor}.${Number.parseInt(match.groups.patch, 10) + 1}`;
}

async function createSigningKeyFile(tempRoot) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(tempRoot, "release-signing-key.pem");
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { encoding: "utf8", mode: 0o600 },
  );
  return privateKeyPath;
}

function buildRuntimeArtifacts(repoRootPath, artifactDir, runtimeVersion, privateKeyPath) {
  run(
    "node",
    [
      "scripts/build-public-runtime-artifacts.mjs",
      "--out-dir",
      artifactDir,
      "--runtime-version-override",
      runtimeVersion,
      "--private-key-file",
      privateKeyPath,
      "--key-id",
      "local-dev",
      "--allow-missing-bundled-external-plugins",
      "--skip-build",
    ],
    repoRootPath,
  );
}

async function writeCanonicalConfig(homeDir) {
  const operatorHome = path.join(homeDir, ".agenc");
  const configPath = path.join(operatorHome, "config.json");
  await mkdir(operatorHome, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          port: 4310,
          bind: "127.0.0.1",
        },
        agent: {
          name: "public-install-smoke",
        },
        connection: {
          rpcUrl: "http://127.0.0.1:8899",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return configPath;
}

async function packPreparedWrapper(repoRootPath, artifactDir, tempRoot, label) {
  run(
    "node",
    ["scripts/prepare-public-agenc-package.mjs", "--artifact-dir", artifactDir],
    repoRootPath,
  );
  const packed = JSON.parse(run("npm", ["pack", "--json"], wrapperDir))[0];
  if (!packed?.filename) {
    throw new Error("npm pack did not return a tarball filename for agenc");
  }
  const originalTarballPath = path.join(wrapperDir, packed.filename);
  const packedPackageJson = readPackedWrapperPackageJson(
    originalTarballPath,
    repoRootPath,
  );
  assert.equal(
    packedPackageJson.name,
    "@tetsuo-ai/agenc",
    "packed wrapper package.json must publish the scoped npm identity",
  );
  const tarballPath = path.join(tempRoot, `${label}-${packed.filename}`);
  await copyFile(originalTarballPath, tarballPath);
  await unlink(originalTarballPath);
  return tarballPath;
}

function installWrapperTarball(repoRootPath, prefixDir, homeDir, tarballPath, force = false) {
  const installArgs = [
    "install",
    "--global",
    "--no-fund",
    "--no-audit",
    "--prefix",
    prefixDir,
  ];
  if (force) {
    installArgs.push("--force");
  }
  installArgs.push(tarballPath);
  run("npm", installArgs, repoRootPath, {
    ...process.env,
    HOME: homeDir,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenc-public-install."));
  const artifactDirV1 = path.join(tempRoot, "artifacts-v1");
  const artifactDirV2 = path.join(tempRoot, "artifacts-v2");
  const prefixDir = path.join(tempRoot, "prefix");
  const homeDir = path.join(tempRoot, "home");
  const wrapperTarballPaths = [];
  const runtimePackage = JSON.parse(
    await readFile(path.join(repoRoot, "runtime", "package.json"), "utf8"),
  );
  const initialRuntimeVersion = runtimePackage.version;
  const upgradedRuntimeVersion = bumpPatchVersion(initialRuntimeVersion);
  const expectedPlatform = process.platform;
  const expectedArch = process.arch;
  const expectedPlatformArch = expectedPlatform + "-" + expectedArch;

  try {
    if (!options.skipBuild) {
      process.stdout.write("[public-install-smoke] building runtime\n");
      run("npm", ["run", "build", "--workspace=@tetsuo-ai/runtime"], repoRoot);
      process.stdout.write("[public-install-smoke] building dashboard\n");
      run(
        "npm",
        ["run", "build", "--workspace=@tetsuo-ai/web"],
        repoRoot,
        {
          ...process.env,
          AGENC_DASHBOARD_BASE: "/ui/",
        },
      );
      process.stdout.write("[public-install-smoke] syncing dashboard assets\n");
      run("node", ["scripts/sync-dashboard-assets.mjs"], repoRoot);
    }

    const privateKeyPath = await createSigningKeyFile(tempRoot);

    process.stdout.write("[public-install-smoke] building initial runtime artifacts\n");
    buildRuntimeArtifacts(
      repoRoot,
      artifactDirV1,
      initialRuntimeVersion,
      privateKeyPath,
    );

    process.stdout.write("[public-install-smoke] embedding initial manifest into wrapper package\n");
    const wrapperTarballV1 = await packPreparedWrapper(
      repoRoot,
      artifactDirV1,
      tempRoot,
      "wrapper-v1",
    );
    wrapperTarballPaths.push(wrapperTarballV1);

    process.stdout.write("[public-install-smoke] installing wrapper globally into temp prefix\n");
    installWrapperTarball(repoRoot, prefixDir, homeDir, wrapperTarballV1);
    await writeCanonicalConfig(homeDir);

    const binDir = path.join(prefixDir, "bin");
    const agencBin = path.join(binDir, "agenc");
    const agencRuntimeBin = path.join(binDir, "agenc-runtime");
    const execEnv = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };

    run(agencBin, ["runtime", "uninstall", "--force"], repoRoot, execEnv);
    run(agencBin, ["runtime", "install"], repoRoot, execEnv);
    const wherePayload = runJson(
      agencBin,
      ["runtime", "where"],
      repoRoot,
      execEnv,
    );
    assert.equal(wherePayload.installed, true);
    assert.equal(typeof wherePayload.releaseDir, "string");
    assert.equal(typeof wherePayload.currentDir, "string");
    assert.equal(wherePayload.selectedArtifact?.platform, expectedPlatform);
    assert.equal(wherePayload.selectedArtifact?.arch, expectedArch);
    assert.equal(wherePayload.selectedArtifact?.runtimeVersion, initialRuntimeVersion);
    assert.equal(wherePayload.trustPolicy?.releaseChannel, "local-dev");

    const currentDirStat = await lstat(wherePayload.currentDir);
    assert.equal(currentDirStat.isSymbolicLink(), true);
    assert.equal(await readlink(wherePayload.currentDir), wherePayload.releaseDir);

    const statusPayload = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(statusPayload.status, "ok");
    assert.equal(statusPayload.command, "status");
    assert.equal(statusPayload.running, false);

    const dashboardUrl = run(
      agencBin,
      ["ui", "--no-open"],
      repoRoot,
      execEnv,
    ).trim();
    assert.match(dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/ui\/$/u);
    const dashboardResponse = await fetch(dashboardUrl);
    assert.equal(dashboardResponse.status, 200);
    assert.match(await dashboardResponse.text(), /dashboard|<html/i);

    const runningStatusPayload = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(runningStatusPayload.status, "ok");
    assert.equal(runningStatusPayload.command, "status");
    assert.equal(runningStatusPayload.running, true);
    run(agencBin, ["stop"], repoRoot, execEnv);
    const stoppedStatusPayload = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(stoppedStatusPayload.running, false);

    const installStatePath = path.join(homeDir, ".agenc", "runtime", "install-state.json");
    const installStateV1 = JSON.parse(await readFile(installStatePath, "utf8"));
    assert.equal(installStateV1.runtimeVersion, initialRuntimeVersion);
    const currentSymlinkTargetV1 = wherePayload.releaseDir;

    process.stdout.write("[public-install-smoke] building upgraded runtime artifacts\n");
    buildRuntimeArtifacts(
      repoRoot,
      artifactDirV2,
      upgradedRuntimeVersion,
      privateKeyPath,
    );

    process.stdout.write("[public-install-smoke] embedding upgraded manifest into wrapper package\n");
    const wrapperTarballV2 = await packPreparedWrapper(
      repoRoot,
      artifactDirV2,
      tempRoot,
      "wrapper-v2",
    );
    wrapperTarballPaths.push(wrapperTarballV2);

    process.stdout.write("[public-install-smoke] reinstalling wrapper with upgraded manifest\n");
    installWrapperTarball(repoRoot, prefixDir, homeDir, wrapperTarballV2, true);

    run(agencBin, ["runtime", "update"], repoRoot, execEnv);
    const upgradedWherePayload = runJson(
      agencBin,
      ["runtime", "where"],
      repoRoot,
      execEnv,
    );
    assert.equal(
      upgradedWherePayload.selectedArtifact?.runtimeVersion,
      upgradedRuntimeVersion,
    );
    assert.notEqual(upgradedWherePayload.releaseDir, currentSymlinkTargetV1);
    assert.match(
      upgradedWherePayload.releaseDir,
      new RegExp("releases/" + upgradedRuntimeVersion.replace(/\./gu, "\\.") + "/" + expectedPlatformArch + "$", "u"),
    );
    const upgradedCurrentDirStat = await lstat(upgradedWherePayload.currentDir);
    assert.equal(upgradedCurrentDirStat.isSymbolicLink(), true);
    assert.equal(
      await readlink(upgradedWherePayload.currentDir),
      upgradedWherePayload.releaseDir,
    );
    const installStateV2 = JSON.parse(await readFile(installStatePath, "utf8"));
    assert.equal(installStateV2.runtimeVersion, upgradedRuntimeVersion);
    assert.equal(installStateV2.releaseDir, upgradedWherePayload.releaseDir);
    assert.equal(installStateV2.currentDir, upgradedWherePayload.currentDir);

    const upgradedStatusPayload = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(upgradedStatusPayload.status, "ok");
    assert.equal(upgradedStatusPayload.command, "status");
    assert.equal(upgradedStatusPayload.running, false);

    run(agencBin, ["runtime", "uninstall", "--force"], repoRoot, execEnv);
    const lazyReinstallStatus = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(lazyReinstallStatus.status, "ok");
    assert.equal(lazyReinstallStatus.command, "status");
    assert.equal(lazyReinstallStatus.running, false);

    const runtimeAliasStatus = runJson(
      agencRuntimeBin,
      ["status"],
      repoRoot,
      execEnv,
    );
    assert.equal(runtimeAliasStatus.status, "ok");
    assert.equal(runtimeAliasStatus.command, "status");
    assert.equal(runtimeAliasStatus.running, false);

    const state = JSON.parse(await readFile(installStatePath, "utf8"));
    if (typeof state.releaseDir !== "string" || state.releaseDir.length === 0) {
      throw new Error(`unexpected install state payload at ${installStatePath}`);
    }
    if (typeof state.currentDir !== "string" || state.currentDir.length === 0) {
      throw new Error(`unexpected currentDir in install state at ${installStatePath}`);
    }
    assert.equal(state.runtimeVersion, upgradedRuntimeVersion);

    process.stdout.write("[public-install-smoke] smoke-ok\n");
  } finally {
    await unlink(path.join(generatedDir, "agenc-runtime-manifest.json")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-manifest.json.sig")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-public-key.pem")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-trust-policy.json")).catch(() => {});
    for (const wrapperTarballPath of wrapperTarballPaths) {
      await unlink(wrapperTarballPath).catch(() => {});
    }
    if (options.keepTemp) {
      process.stdout.write(`[public-install-smoke] kept temp directory ${tempRoot}\n`);
      return;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
