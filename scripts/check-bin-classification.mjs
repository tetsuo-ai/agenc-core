#!/usr/bin/env node
// Verify runtime/src/bin/MIGRATION.md classifies every production bin source.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const BIN_CLASSIFICATIONS = Object.freeze([
  "client-only",
  "daemon-only",
  "shared",
]);

const BIN_REL_DIR = "runtime/src/bin";
const MIGRATION_REL_PATH = `${BIN_REL_DIR}/MIGRATION.md`;

export function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isProductionBinSourceFile(fileName) {
  return (
    fileName.endsWith(".ts") &&
    !fileName.endsWith(".test.ts") &&
    !fileName.endsWith(".contract.test.ts") &&
    !fileName.endsWith(".d.ts")
  );
}

export function discoverBinSourceFiles(root) {
  const binDir = path.join(root, BIN_REL_DIR);
  if (!existsSync(binDir)) {
    throw new Error(`missing bin directory: ${BIN_REL_DIR}`);
  }
  const files = [];
  const visit = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!entry.isFile() || !isProductionBinSourceFile(entry.name)) continue;
      files.push(normalizeRepoPath(path.relative(root, abs)));
    }
  };
  visit(binDir);
  return files.sort((a, b) => a.localeCompare(b));
}

export function parseMigrationInventory(markdown) {
  const entries = [];
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gm;
  let match;
  while ((match = rowRe.exec(markdown)) !== null) {
    const relPath = normalizeRepoPath(match[1].trim());
    if (!relPath.startsWith(`${BIN_REL_DIR}/`) || !relPath.endsWith(".ts")) {
      continue;
    }
    const classification = match[2].trim().toLowerCase();
    entries.push({ relPath, classification });
  }
  return entries;
}

export function compareBinClassification({ sourceFiles, entries }) {
  const sourceSet = new Set(sourceFiles);
  const seen = new Map();
  const invalid = [];
  const extra = [];
  const duplicates = [];

  for (const entry of entries) {
    if (!BIN_CLASSIFICATIONS.includes(entry.classification)) {
      invalid.push(entry);
    }
    if (!sourceSet.has(entry.relPath)) {
      extra.push(entry.relPath);
    }
    const prior = seen.get(entry.relPath);
    if (prior !== undefined) {
      duplicates.push(entry.relPath);
    }
    seen.set(entry.relPath, entry.classification);
  }

  const missing = sourceFiles.filter((file) => !seen.has(file));
  return {
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      invalid.length === 0 &&
      duplicates.length === 0,
    missing,
    extra: [...new Set(extra)].sort((a, b) => a.localeCompare(b)),
    invalid,
    duplicates: [...new Set(duplicates)].sort((a, b) => a.localeCompare(b)),
    classifiedCount: seen.size,
    sourceCount: sourceFiles.length,
  };
}

export function findDaemonOnlyEntries(entries) {
  return entries
    .filter((entry) => entry.classification === "daemon-only")
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function binImportTarget(importerRelPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const importerDir = path.posix.dirname(importerRelPath);
  const rawTarget = path.posix.normalize(path.posix.join(importerDir, specifier));
  const tsTarget = rawTarget.replace(/\.js$/, ".ts");
  return tsTarget.startsWith(`${BIN_REL_DIR}/`) ? tsTarget : null;
}

export function directBinImportsFromSource(importerRelPath, source) {
  const imports = [];
  const importRe =
    /(?:\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\))/g;
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) continue;
    const target = binImportTarget(importerRelPath, specifier);
    if (target !== null) imports.push(target);
  }
  return [...new Set(imports)].sort((a, b) => a.localeCompare(b));
}

export function findSideDependencyContradictions(root, entries) {
  const classificationByPath = new Map(
    entries.map((entry) => [entry.relPath, entry.classification]),
  );
  const contradictions = [];
  for (const [relPath, classification] of classificationByPath) {
    if (classification !== "shared") continue;
    const sourcePath = path.join(root, relPath);
    if (!existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, "utf8");
    for (const target of directBinImportsFromSource(relPath, source)) {
      const targetClassification = classificationByPath.get(target);
      if (
        targetClassification !== undefined &&
        targetClassification !== "shared"
      ) {
        contradictions.push({
          from: relPath,
          fromClassification: classification,
          to: target,
          toClassification: targetClassification,
        });
      }
    }
  }
  return contradictions;
}

export function buildBinClassificationReport(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const migrationPath = path.join(root, MIGRATION_REL_PATH);
  if (!existsSync(migrationPath)) {
    throw new Error(`missing migration inventory: ${MIGRATION_REL_PATH}`);
  }
  const sourceFiles = discoverBinSourceFiles(root);
  const entries = parseMigrationInventory(readFileSync(migrationPath, "utf8"));
  const comparison = compareBinClassification({ sourceFiles, entries });
  const sideDependencyContradictions = comparison.ok
    ? findSideDependencyContradictions(root, entries)
    : [];
  const daemonOnlyEntries = findDaemonOnlyEntries(entries);
  const daemonOnlyAllowed = options.forbidDaemonOnly !== true;
  return {
    root,
    migrationPath: MIGRATION_REL_PATH,
    sourceFiles,
    entries,
    ...comparison,
    ok:
      comparison.ok &&
      sideDependencyContradictions.length === 0 &&
      (daemonOnlyAllowed || daemonOnlyEntries.length === 0),
    sideDependencyContradictions,
    forbidDaemonOnly: options.forbidDaemonOnly === true,
    daemonOnlyEntries,
  };
}

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/check-bin-classification.mjs [--root <dir>] [--json] [--forbid-daemon-only]",
      "",
      "Fails when runtime/src/bin/MIGRATION.md does not classify every non-test .ts file under runtime/src/bin/ as client-only, daemon-only, or shared.",
      "With --forbid-daemon-only, also fails when any runtime/src/bin file remains daemon-only.",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    json: false,
    forbidDaemonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root requires a value");
      parsed.root = value;
      i += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--forbid-daemon-only") {
      parsed.forbidDaemonOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printReport(report) {
  if (report.ok) {
    const suffix = report.forbidDaemonOnly ? "; no daemon-only bin files" : "";
    process.stdout.write(
      `bin classification complete (${report.classifiedCount}/${report.sourceCount} source files${suffix})\n`,
    );
    return;
  }
  process.stderr.write(
    `${MIGRATION_REL_PATH} is out of sync with ${BIN_REL_DIR}.\n`,
  );
  if (report.missing.length > 0) {
    process.stderr.write("Missing source file row(s):\n");
    for (const file of report.missing) process.stderr.write(`- ${file}\n`);
  }
  if (report.extra.length > 0) {
    process.stderr.write("Extra row(s) without a source file:\n");
    for (const file of report.extra) process.stderr.write(`- ${file}\n`);
  }
  if (report.invalid.length > 0) {
    process.stderr.write("Invalid classification row(s):\n");
    for (const entry of report.invalid) {
      process.stderr.write(`- ${entry.relPath}: ${entry.classification}\n`);
    }
  }
  if (report.duplicates.length > 0) {
    process.stderr.write("Duplicate row(s):\n");
    for (const file of report.duplicates) process.stderr.write(`- ${file}\n`);
  }
  if (report.sideDependencyContradictions.length > 0) {
    process.stderr.write("Side dependency contradiction(s):\n");
    for (const edge of report.sideDependencyContradictions) {
      process.stderr.write(
        `- ${edge.from} (${edge.fromClassification}) imports ${edge.to} (${edge.toClassification})\n`,
      );
    }
  }
  if (report.forbidDaemonOnly && report.daemonOnlyEntries.length > 0) {
    process.stderr.write("Daemon-only bin file row(s) are forbidden:\n");
    for (const entry of report.daemonOnlyEntries) {
      process.stderr.write(`- ${entry.relPath}\n`);
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage();
    process.exit(2);
  }

  try {
    const report = buildBinClassificationReport(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`bin classification check failed: ${error.message}\n`);
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
