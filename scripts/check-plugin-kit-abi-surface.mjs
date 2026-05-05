#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenRuntimePattern =
  /\b(ChannelAdapter|CHANNEL_ADAPTER|certifyChannelAdapter|certifyChannelAdapterModule|createChannelAdapter|channel_adapter|channel-host-matrix)\b/u;

function fail(message, detail = "") {
  process.stderr.write(`${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.silent ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed`,
      `${result.stdout || ""}${result.stderr || ""}`.trim(),
    );
  }
  return result;
}

function walkFiles(dir) {
  const entries = [];
  if (!existsSync(dir)) return entries;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const fullPath = path.join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry !== "node_modules") stack.push(fullPath);
      } else if (stat.isFile()) {
        entries.push(fullPath);
      }
    }
  }
  return entries;
}

function assertNoRuntimeConsumers() {
  const runtimeDir = path.join(root, "runtime/src");
  const offenders = [];
  for (const file of walkFiles(runtimeDir)) {
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md)$/u.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (forbiddenRuntimePattern.test(source)) {
      offenders.push(path.relative(root, file));
    }
  }
  if (offenders.length > 0) {
    fail(
      "Runtime still consumes the removed plugin-kit ABI.",
      offenders.map((file) => `  - ${file}`).join("\n"),
    );
  }
}

function candidatePackageDirs() {
  return [
    process.env.AGENC_PLUGIN_KIT_DIR,
    path.resolve(root, "..", "agenc-plugin-kit"),
  ].filter(Boolean);
}

function findPluginKitDir() {
  for (const candidate of candidatePackageDirs()) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  fail(
    "Could not find agenc-plugin-kit checkout.",
    `Checked:\n${candidatePackageDirs().map((p) => `  - ${p}`).join("\n")}`,
  );
}

function assertPackageManifest(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@tetsuo-ai/plugin-kit") {
    fail(`Unexpected plugin-kit package name in ${packageJsonPath}`);
  }
  for (const subpath of ["./channel-host-matrix", "./channel-host-matrix.json"]) {
    if (Object.prototype.hasOwnProperty.call(packageJson.exports ?? {}, subpath)) {
      fail(`Dead plugin-kit ABI subpath is still exported: ${subpath}`);
    }
  }
}

function assertPackedPackage(packageDir) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agenc-plugin-kit-abi-"));
  try {
    const packDir = path.join(tempDir, "pack");
    mkdirSync(packDir, { recursive: true });
    const pack = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
      { cwd: packageDir, silent: true },
    );
    const packed = JSON.parse(pack.stdout);
    const tarballName = packed.at(-1)?.filename;
    if (!tarballName) fail("npm pack did not produce a tarball.");
    const tarballPath = path.join(packDir, tarballName);

    run("npm", ["init", "-y"], { cwd: tempDir, silent: true });
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      { cwd: tempDir, silent: true },
    );

    const smokePath = path.join(tempDir, "check-plugin-kit.cjs");
    writeFileSync(
      smokePath,
      [
        "const assert = require('node:assert/strict');",
        "const pluginKit = require('@tetsuo-ai/plugin-kit');",
        "const visibleKeys = Object.keys(pluginKit).filter((key) => key !== '__esModule');",
        "assert.deepEqual(visibleKeys, []);",
        "for (const specifier of [",
        "  '@tetsuo-ai/plugin-kit/channel-host-matrix',",
        "  '@tetsuo-ai/plugin-kit/channel-host-matrix.json',",
        "]) {",
        "  assert.throws(",
        "    () => require.resolve(specifier),",
        "    (error) => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',",
        "  );",
        "}",
        "console.log('plugin-kit-abi-surface-ok');",
      ].join("\n"),
      "utf8",
    );
    const smoke = run("node", [smokePath], { cwd: tempDir, silent: true });
    if (smoke.stdout.trim() !== "plugin-kit-abi-surface-ok") {
      fail(`Unexpected plugin-kit smoke output: ${smoke.stdout.trim()}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

assertNoRuntimeConsumers();
const packageDir = findPluginKitDir();
assertPackageManifest(packageDir);
assertPackedPackage(packageDir);
process.stdout.write("plugin-kit ABI dead surface removed\n");
