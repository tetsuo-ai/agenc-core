#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agenc-public-install."));
  const artifactDir = path.join(tempRoot, "artifacts");
  const prefixDir = path.join(tempRoot, "prefix");
  const homeDir = path.join(tempRoot, "home");
  let wrapperTarballPath = null;

  try {
    if (!options.skipBuild) {
      process.stdout.write("[public-install-smoke] building runtime\n");
      run("npm", ["run", "build", "--workspace=@tetsuo-ai/runtime"], repoRoot);
    }

    process.stdout.write("[public-install-smoke] building runtime artifacts\n");
    run(
      "node",
      ["scripts/build-public-runtime-artifacts.mjs", "--out-dir", artifactDir, "--skip-build"],
      repoRoot,
    );

    process.stdout.write("[public-install-smoke] embedding manifest into wrapper package\n");
    run(
      "node",
      ["scripts/prepare-public-agenc-package.mjs", "--artifact-dir", artifactDir],
      repoRoot,
    );

    const packed = JSON.parse(run("npm", ["pack", "--json"], wrapperDir))[0];
    if (!packed?.filename) {
      throw new Error("npm pack did not return a tarball filename for agenc");
    }
    wrapperTarballPath = path.join(wrapperDir, packed.filename);

    process.stdout.write("[public-install-smoke] installing wrapper globally into temp prefix\n");
    run(
      "npm",
      ["install", "--global", "--no-fund", "--no-audit", "--prefix", prefixDir, wrapperTarballPath],
      repoRoot,
      {
        ...process.env,
        HOME: homeDir,
      },
    );

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
    assert.equal(wherePayload.selectedArtifact?.platform, "linux");
    assert.equal(wherePayload.selectedArtifact?.arch, "x64");
    assert.equal(wherePayload.trustPolicy?.releaseChannel, "local-dev");

    const currentDirStat = await lstat(wherePayload.currentDir);
    assert.equal(currentDirStat.isSymbolicLink(), true);

    const statusPayload = runJson(agencBin, ["status"], repoRoot, execEnv);
    assert.equal(statusPayload.status, "ok");
    assert.equal(statusPayload.command, "status");
    assert.equal(statusPayload.running, false);

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

    const statePath = path.join(homeDir, ".agenc", "runtime", "install-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof state.releaseDir !== "string" || state.releaseDir.length === 0) {
      throw new Error(`unexpected install state payload at ${statePath}`);
    }
    if (typeof state.currentDir !== "string" || state.currentDir.length === 0) {
      throw new Error(`unexpected currentDir in install state at ${statePath}`);
    }

    process.stdout.write("[public-install-smoke] smoke-ok\n");
  } finally {
    await unlink(path.join(generatedDir, "agenc-runtime-manifest.json")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-manifest.json.sig")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-public-key.pem")).catch(() => {});
    await unlink(path.join(generatedDir, "agenc-runtime-trust-policy.json")).catch(() => {});
    if (wrapperTarballPath) {
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
