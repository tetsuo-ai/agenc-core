#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageDir = path.dirname(packageJsonPath);
const runtimeInternalEntrypoints = [];
const requiredRootExports = [
  "VERSION",
  "AgenCDaemonJsonRpcDispatcher",
  "AgenCInProcessDaemonTransport",
  "startAgenCInProcessDaemonTransport",
  "EVAL_CONTRACT_VERSION",
  "validateDerivedSummaryAgainstBundle",
  "validateEvalContractDocument",
];
const requiredRuntimeAssetPaths = [
  "dist/yolo-classifier-prompts/auto_mode_system_prompt.txt",
  "dist/yolo-classifier-prompts/permissions_anthropic.txt",
  "dist/yolo-classifier-prompts/permissions_external.txt",
];

function collectPackageEntryPaths(packageManifest) {
  const paths = new Set();

  const maybeAdd = (value) => {
    if (typeof value !== "string") {
      return;
    }
    if (value.startsWith("./")) {
      paths.add(value.slice(2));
      return;
    }
    if (!value.startsWith("/")) {
      paths.add(value);
    }
  };

  maybeAdd(packageManifest.main);
  maybeAdd(packageManifest.module);
  maybeAdd(packageManifest.types);

  if (packageManifest.bin && typeof packageManifest.bin === "object") {
    for (const binTarget of Object.values(packageManifest.bin)) {
      maybeAdd(binTarget);
    }
  } else {
    maybeAdd(packageManifest.bin);
  }

  const walkExports = (value) => {
    if (typeof value === "string") {
      maybeAdd(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walkExports(entry);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) {
        walkExports(entry);
      }
    }
  };

  walkExports(packageManifest.exports);
  return [...paths];
}

async function main() {
  const packageManifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const expectedPaths = new Set([
    ...collectPackageEntryPaths(packageManifest),
    ...runtimeInternalEntrypoints,
  ]);
  const missingPaths = [];

  for (const relPath of expectedPaths) {
    if (relPath.startsWith("node:") || relPath.startsWith("#")) {
      continue;
    }

    const fullPath = path.join(packageDir, relPath);
    try {
      await access(fullPath);
    } catch {
      missingPaths.push(relPath);
    }
  }

  for (const relPath of requiredRuntimeAssetPaths) {
    const fullPath = path.join(packageDir, relPath);
    try {
      await access(fullPath);
    } catch {
      missingPaths.push(relPath);
    }
  }

  await checkRequiredRootExports(packageManifest);

  if (missingPaths.length > 0) {
    throw new Error(
      `runtime package metadata references missing built entries:\n- ${missingPaths.join("\n- ")}`,
    );
  }

  process.stdout.write(
    `[runtime build contract] verified ${packageManifest.name} entrypoints (${expectedPaths.size})\n`,
  );
}

async function checkRequiredRootExports(packageManifest) {
  const rootExport = packageManifest.exports?.["."] ?? packageManifest.main;
  const importTarget =
    typeof rootExport === "string"
      ? rootExport
      : rootExport?.import ?? rootExport?.default;
  if (typeof importTarget !== "string") {
    throw new Error("runtime package root export does not expose an import target");
  }

  const rootModule = await import(
    pathToFileURL(path.join(packageDir, normalizePackagePath(importTarget))).href
  );
  const missingExports = requiredRootExports.filter(
    (name) => !(name in rootModule),
  );
  if (missingExports.length > 0) {
    throw new Error(
      `runtime package root export is missing required exports:\n- ${missingExports.join("\n- ")}`,
    );
  }
  if (rootModule.EVAL_CONTRACT_VERSION !== "1.0.0") {
    throw new Error("runtime package root export has the wrong evaluation contract version");
  }
  if (typeof rootModule.validateEvalContractDocument !== "function") {
    throw new Error("runtime package root evaluation validator is not callable");
  }
}

function normalizePackagePath(value) {
  return value.startsWith("./") ? value.slice(2) : value;
}

await main();
