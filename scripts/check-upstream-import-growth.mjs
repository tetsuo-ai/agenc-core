#!/usr/bin/env node
// Fail when a candidate adds production importers of runtime/src/agenc/upstream.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const UPSTREAM_IMPORT_SEARCH_PATTERN = "from .*agenc/upstream/";

export function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isProductionTypeScriptPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return (
    normalized.startsWith("runtime/src/") &&
    /\.(ts|tsx)$/.test(normalized) &&
    !/\.test\./.test(normalized)
  );
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function compareImporterSets(baseFiles, candidateFiles) {
  const base = uniqueSorted(baseFiles);
  const candidate = uniqueSorted(candidateFiles);
  const baseSet = new Set(base);
  return {
    base,
    candidate,
    baseCount: base.length,
    candidateCount: candidate.length,
    delta: candidate.length - base.length,
    addedImporterFiles: candidate.filter((file) => !baseSet.has(file)),
  };
}

export function importerFilesFromRipgrepOutput(output) {
  return uniqueSorted(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeRepoPath)
      .filter(isProductionTypeScriptPath),
  );
}

export function importerFilesFromGitGrepOutput(output, ref) {
  const prefix = `${ref}:`;
  return uniqueSorted(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
      .map(normalizeRepoPath)
      .filter(isProductionTypeScriptPath),
  );
}

function runCommand(cmd, args, options) {
  return spawnSync(cmd, args, {
    cwd: options.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function importerFilesAtRef(root, ref) {
  const result = runCommand(
    "git",
    ["grep", "-l", "-E", UPSTREAM_IMPORT_SEARCH_PATTERN, ref, "--", "runtime/src"],
    { root },
  );
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `git grep failed for ${ref}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return importerFilesFromGitGrepOutput(result.stdout, ref);
}

function importerFilesInWorktree(root) {
  if (!existsSync(path.join(root, "runtime", "src"))) return [];
  const result = runCommand(
    "rg",
    [
      "--no-messages",
      "-l",
      UPSTREAM_IMPORT_SEARCH_PATTERN,
      "runtime/src",
      "--glob",
      "*.ts",
      "--glob",
      "*.tsx",
    ],
    { root },
  );
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `rg failed while scanning the candidate tree: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return importerFilesFromRipgrepOutput(result.stdout);
}

export function buildUpstreamImportGrowthReport(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const baseRef = options.baseRef ?? "main";
  const candidateRef = options.candidateRef ?? "worktree";
  const baseFiles = importerFilesAtRef(root, baseRef);
  const candidateFiles =
    candidateRef === "worktree"
      ? importerFilesInWorktree(root)
      : importerFilesAtRef(root, candidateRef);
  return {
    root,
    baseRef,
    candidateRef,
    ...compareImporterSets(baseFiles, candidateFiles),
  };
}

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/check-upstream-import-growth.mjs [--root <dir>] [--base <ref>] [--candidate <ref|worktree>] [--json]",
      "",
      "Fails when the candidate has more production TypeScript importers of runtime/src/agenc/upstream than the base ref.",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    baseRef: "main",
    candidateRef: "worktree",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root requires a value");
      parsed.root = value;
      i += 1;
    } else if (arg === "--base") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--base requires a value");
      parsed.baseRef = value;
      i += 1;
    } else if (arg === "--candidate") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--candidate requires a value");
      parsed.candidateRef = value;
      i += 1;
    } else if (arg === "--json") {
      parsed.json = true;
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
  if (report.delta <= 0) {
    process.stdout.write(
      `upstream importer count did not grow (${report.baseRef}: ${report.baseCount}, ${report.candidateRef}: ${report.candidateCount}, delta ${report.delta})\n`,
    );
    return;
  }
  process.stderr.write(
    `forbidden: production importers of runtime/src/agenc/upstream grew from ${report.baseCount} to ${report.candidateCount} (+${report.delta}).\n`,
  );
  if (report.addedImporterFiles.length > 0) {
    process.stderr.write("New candidate importer file(s):\n");
    for (const file of report.addedImporterFiles) {
      process.stderr.write(`- ${file}\n`);
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
    const report = buildUpstreamImportGrowthReport(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report);
    }
    process.exit(report.delta > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`upstream importer growth check failed: ${error.message}\n`);
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
