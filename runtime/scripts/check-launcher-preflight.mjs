#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedPath = resolve(runtimeRoot, "../packages/agenc/generated/startup-preflight.mjs");
const allowedInputs = new Set([
  "src/bin/startup-preflight.ts",
  "src/bin/cli-option-region.ts",
  "src/bin/route.ts",
  "src/bin/startup-flags.ts",
]);

export async function renderLauncherPreflight() {
  const result = await build({
    absWorkingDir: runtimeRoot,
    entryPoints: ["src/bin/startup-preflight.ts"],
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "node",
    target: "node26",
    minifyWhitespace: true,
    legalComments: "none",
    metafile: true,
    write: false,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!allowedInputs.has(input.replaceAll("\\", "/"))) {
      throw new Error(`launcher preflight has an unexpected dependency: ${input}`);
    }
  }
  if (Object.values(result.metafile.outputs).some((output) => output.imports.length > 0)) {
    throw new Error("launcher preflight must not import runtime modules");
  }
  if (result.outputFiles.length !== 1) {
    throw new Error("launcher preflight must be one self-contained module");
  }
  return result.outputFiles[0].text;
}

export async function checkLauncherPreflight({ mode = "check", outputPath = generatedPath } = {}) {
  if (mode !== "check" && mode !== "write") {
    throw new Error("usage: check-launcher-preflight.mjs [--check | --write]");
  }
  const rendered = await renderLauncherPreflight();
  if (mode === "write") {
    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, rendered, { flag: "wx", mode: 0o644 });
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return;
  }
  const existing = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== rendered) {
    throw new Error("launcher startup preflight is stale; run node runtime/scripts/check-launcher-preflight.mjs --write");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const mode = args.length === 0 || (args.length === 1 && args[0] === "--check")
    ? "check"
    : args.length === 1 && args[0] === "--write" ? "write" : "invalid";
  await checkLauncherPreflight({ mode }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
