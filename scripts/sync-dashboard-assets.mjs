#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    sourceDir: path.join(repoRoot, "web", "dist"),
    outputDir: path.join(repoRoot, "runtime", "dist", "dashboard"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--source-dir":
        options.sourceDir = path.resolve(argv[++index]);
        break;
      case "--output-dir":
        options.outputDir = path.resolve(argv[++index]);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

async function ensureFileExists(filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`${filePath} exists but is not a file`);
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      throw new Error(
        `dashboard build is missing at ${filePath}; build the web app before syncing dashboard assets`,
      );
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureFileExists(path.join(options.sourceDir, "index.html"));

  await mkdir(path.dirname(options.outputDir), { recursive: true });
  await rm(options.outputDir, { recursive: true, force: true });
  await cp(options.sourceDir, options.outputDir, { recursive: true });

  process.stdout.write(
    `${JSON.stringify(
      {
        sourceDir: options.sourceDir,
        outputDir: options.outputDir,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
