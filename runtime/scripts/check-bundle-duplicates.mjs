#!/usr/bin/env node

// Fails the build when one package is both inlined into the emitted chunks and
// imported from node_modules by shipped code. Two copies of a package in one
// process break singleton state: chalk's color-level adjustments in
// src/tui/ink/colorize.ts only reach the copy that loader initialized, so
// theme decisions elsewhere in the app disagree with the renderer (#3274).
//
// "Inlined" means the package has files in the esbuild metafile's inputs: the
// bundler resolved and parsed them on the bundled side of the graph. The
// runtime build wires this into scripts/build-runtime.mjs. The CLI form audits
// an esbuild metafile JSON directly:
//
//   node scripts/check-bundle-duplicates.mjs metafile.json

import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const NODE_MODULES_PREFIX = "node_modules/";

/** `node_modules/foo/lib/x.js` → `foo`; `node_modules/@scope/pkg/x.js` → `@scope/pkg`. Nested installs resolve to the innermost package. */
export function packageNameFromNodeModulesPath(path) {
  const index = path.lastIndexOf(NODE_MODULES_PREFIX);
  if (index === -1) {
    return null;
  }
  return packageNameFromSpecifier(path.slice(index + NODE_MODULES_PREFIX.length));
}

/** `chalk` → `chalk`; `@scope/pkg/sub` → `@scope/pkg`; relative, absolute and builtin specifiers → null. */
export function packageNameFromSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("data:")
  ) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1
    ? parts.slice(0, 2).join("/")
    : parts[0];
}

export function collectDuplicatePackages(metafile) {
  const inlinedInputCount = new Map();
  for (const path of Object.keys(metafile.inputs ?? {})) {
    const name = packageNameFromNodeModulesPath(path);
    if (name === null) {
      continue;
    }
    inlinedInputCount.set(name, (inlinedInputCount.get(name) ?? 0) + 1);
  }

  const externalImporters = new Map();
  for (const [output, outputMeta] of Object.entries(metafile.outputs ?? {})) {
    for (const imported of outputMeta.imports ?? []) {
      if (!imported.external) {
        continue;
      }
      const name = packageNameFromSpecifier(imported.path);
      if (name === null) {
        continue;
      }
      const importers = externalImporters.get(name) ?? new Set();
      importers.add(output);
      externalImporters.set(name, importers);
    }
  }

  const duplicates = [];
  for (const [name, importers] of externalImporters) {
    if (!inlinedInputCount.has(name)) {
      continue;
    }
    duplicates.push({
      package: name,
      inlinedModuleCount: inlinedInputCount.get(name),
      importedBy: [...importers].sort(),
    });
  }
  duplicates.sort((a, b) => b.inlinedModuleCount - a.inlinedModuleCount);
  return duplicates;
}

export function formatDuplicatePackages(duplicates) {
  const rows = duplicates.map(({ package: name, inlinedModuleCount, importedBy }) => {
    const samples = importedBy.slice(0, 3).join(", ");
    const more = importedBy.length > 3 ? `, +${importedBy.length - 3} more` : "";
    return `  ${name}: ${inlinedModuleCount} inlined module(s), loaded from node_modules by ${samples}${more}`;
  });
  return [
    "packages ship twice: inlined into the bundle graph and loaded from node_modules by shipped chunks:",
    ...rows,
    "",
    "Two copies of a package in one process break singleton state (chalk color",
    "levels are the known case). Load each of these from node_modules everywhere by",
    "adding it to `external` in runtime/build.config.ts, or bundle it everywhere",
    "instead. See #3274.",
  ].join("\n");
}

export function assertNoDuplicatePackages(metafile) {
  const duplicates = collectDuplicatePackages(metafile);
  if (duplicates.length > 0) {
    throw new Error(`[check-bundle-duplicates] ${formatDuplicatePackages(duplicates)}`);
  }
}

async function main() {
  const [metafilePath] = process.argv.slice(2);
  if (metafilePath === undefined) {
    console.error("usage: node scripts/check-bundle-duplicates.mjs <esbuild-metafile.json>");
    process.exit(2);
  }
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  try {
    assertNoDuplicatePackages(metafile);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log("[check-bundle-duplicates] no package is both inlined and loaded from node_modules");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
