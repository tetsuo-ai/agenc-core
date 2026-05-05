#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "runtime/src/app-server/protocol/schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const packageTarget = schema["x-agenc-package"];

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

function candidatePackageDirs() {
  return [
    process.env.AGENC_PROTOCOL_PACKAGE_DIR,
    path.resolve(root, "..", "agenc-protocol", "packages", "protocol"),
  ].filter(Boolean);
}

function findProtocolPackageDir() {
  for (const candidate of candidatePackageDirs()) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  fail(
    "Could not find agenc-protocol package checkout.",
    `Checked:\n${candidatePackageDirs().map((p) => `  - ${p}`).join("\n")}`,
  );
}

function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    return entry.default ?? entry.require ?? entry.import ?? null;
  }
  return null;
}

if (
  !packageTarget ||
  typeof packageTarget.name !== "string" ||
  typeof packageTarget.export !== "string"
) {
  fail("Protocol schema has no usable x-agenc-package target.");
}

const packageDir = findProtocolPackageDir();
const packageJsonPath = path.join(packageDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.name !== packageTarget.name) {
  fail(
    "Protocol package name does not match schema x-agenc-package target.",
    `${packageJsonPath}: expected ${packageTarget.name}, got ${packageJson.name}`,
  );
}

const exported = packageJson.exports?.[packageTarget.export];
const exportedFile = exportTarget(exported);
if (!exportedFile) {
  fail(
    "Protocol package exports map does not expose the schema target.",
    `${packageJsonPath}: missing exports[${JSON.stringify(packageTarget.export)}]`,
  );
}

const exportedPath = path.resolve(packageDir, exportedFile);
if (!existsSync(exportedPath)) {
  fail(
    "Protocol package schema export target does not exist on disk.",
    `${packageTarget.export} -> ${exportedFile}`,
  );
}

const tempDir = mkdtempSync(path.join(tmpdir(), "agenc-protocol-schema-export-"));
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

  const subpath = packageTarget.export.replace(/^\.\//, "");
  const specifier = `${packageTarget.name}/${subpath}`;
  const smokePath = path.join(tempDir, "resolve-schema.cjs");
  writeFileSync(
    smokePath,
    [
      "const assert = require('node:assert/strict');",
      `const specifier = ${JSON.stringify(specifier)};`,
      "const resolved = require.resolve(specifier);",
      "const schema = require(specifier);",
      `assert.equal(schema.$id, ${JSON.stringify(schema.$id)});`,
      `assert.deepEqual(schema["x-agenc-package"], ${JSON.stringify(packageTarget)});`,
      "assert.ok(resolved.endsWith('daemon-json-rpc.schema.json'));",
      "console.log(resolved);",
    ].join("\n"),
    "utf8",
  );
  const smoke = run("node", [smokePath], { cwd: tempDir, silent: true });
  process.stdout.write(
    `Protocol package schema export resolves: ${specifier} -> ${smoke.stdout.trim()}\n`,
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
