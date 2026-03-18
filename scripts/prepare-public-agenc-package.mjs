#!/usr/bin/env node

import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    artifactDir: path.join(repoRoot, "artifacts", "public-runtime"),
    packageDir: path.join(repoRoot, "packages", "agenc"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact-dir":
        options.artifactDir = path.resolve(argv[++index]);
        break;
      case "--package-dir":
        options.packageDir = path.resolve(argv[++index]);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedDir = path.join(options.packageDir, "generated");
  await mkdir(generatedDir, { recursive: true });

  const files = [
    "agenc-runtime-manifest.json",
    "agenc-runtime-manifest.json.sig",
    "agenc-runtime-public-key.pem",
    "agenc-runtime-trust-policy.json",
  ];

  for (const fileName of files) {
    await copyFile(
      path.join(options.artifactDir, fileName),
      path.join(generatedDir, fileName),
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        packageDir: options.packageDir,
        generatedDir,
        files,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
