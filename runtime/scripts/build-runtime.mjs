#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { verifyFreshStateSchemaSources } from "./fresh-state-schema-artifact.mjs";

const require = createRequire(import.meta.url);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(runtimeRoot, "dist");
const configPath = resolve(runtimeRoot, "build.config.ts");
const bundleTsconfigPath = resolve(runtimeRoot, "tsconfig.bundle.json");

async function loadConfig() {
  const source = await readFile(configPath, "utf8");
  const transformed = await transform(source, {
    format: "esm",
    loader: "ts",
    platform: "node",
    sourcefile: configPath,
    sourcemap: "inline",
    target: "node26",
  });

  const tempDir = await mkdtemp(join(tmpdir(), "agenc-build-config-"));
  const modulePath = join(tempDir, "build.config.mjs");
  await writeFile(modulePath, transformed.code, "utf8");

  const previousRuntimeRoot = process.env.AGENC_RUNTIME_ROOT;
  process.env.AGENC_RUNTIME_ROOT = runtimeRoot;
  try {
    const loaded = await import(
      `${pathToFileURL(modulePath).href}?t=${Date.now()}`
    );
    return loaded.default;
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.AGENC_RUNTIME_ROOT;
    } else {
      process.env.AGENC_RUNTIME_ROOT = previousRuntimeRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeConfig(config) {
  if (Array.isArray(config)) {
    if (config.length !== 1) {
      throw new Error("runtime build expects a single build config");
    }
    return config[0];
  }
  return config;
}

function externalPatterns(external = []) {
  const patterns = new Set();
  for (const specifier of external) {
    patterns.add(specifier);
    if (!specifier.endsWith("/*")) {
      patterns.add(`${specifier}/*`);
    }
  }
  return [...patterns];
}

async function runBundle(config) {
  mkdirSync(distDir, { recursive: true });
  for (const entry of readdirSync(distDir)) {
    rmSync(join(distDir, entry), { recursive: true, force: true });
  }

  const options = {
    absWorkingDir: runtimeRoot,
    banner: {},
    bundle: true,
    chunkNames: "[name]-[hash]",
    entryNames: "[dir]/[name]",
    entryPoints: config.entry,
    external: externalPatterns(config.external),
    format: config.format?.[0] ?? "esm",
    loader: {},
    logLevel: "info",
    // V8 parses every loaded chunk in full before running it, so source size
    // is startup time. Identifiers and function names stay as written;
    // dist/*.map maps positions back to the sources.
    minifySyntax: true,
    minifyWhitespace: true,
    outbase: "src",
    outdir: distDir,
    platform: config.platform ?? "node",
    plugins: [{
      name: "micro-print-entry-boundary",
      setup(build) {
        build.onResolve({ filter: /^\.\/micro-print-entry\.js$/ }, args =>
          args.importer.endsWith("/src/bin/agenc.ts") ? { path: args.path, external: true } : null);
      },
    }, ...(config.esbuildPlugins ?? [])],
    sourcemap: config.sourcemap ?? true,
    splitting: true,
    target: config.target ?? "es2022",
    tsconfig: bundleTsconfigPath,
  };

  config.esbuildOptions?.(options);
  await build(options);
  // No shared application chunks in the resident client graph. The ordinary
  // entry remains available as a dynamic fallback before session admission.
  const micro = await build({
    ...options,
    entryPoints: ["src/bin/micro-print-entry.ts"],
    splitting: false,
    metafile: true,
    plugins: (config.esbuildPlugins ?? []).filter(plugin => plugin.name !== "agenc-runtime-assets"),
  });
  await writeFile(join(distDir, "micro-print-imports.json"), JSON.stringify(micro.metafile, null, 2) + "\n");
}

function runDeclarations() {
  const tscBin = require.resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [
      tscBin,
      "--emitDeclarationOnly",
      "--declaration",
      "--declarationMap",
      "--outDir",
      "dist",
    ],
    {
      cwd: runtimeRoot,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`declaration emit failed with exit code ${result.status}`);
  }
}

// The runtime bundles @tetsuo-ai/agenc-sdk (the gateway's daemon client), but
// the SDK workspace commits only src/ — its dist/, which the package exports
// point at, is a build artifact. A fresh checkout (release CI, new clone) has
// no dist and esbuild fails with "Could not resolve @tetsuo-ai/agenc-sdk", so
// build it first when its entry is missing.
function ensureSdkWorkspaceBuilt() {
  const sdkRoot = resolve(runtimeRoot, "..", "packages", "agenc-sdk");
  if (existsSync(resolve(sdkRoot, "dist", "index.js"))) {
    return;
  }
  console.log("[build] @tetsuo-ai/agenc-sdk dist missing — building the SDK workspace");
  const res = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--workspace=@tetsuo-ai/agenc-sdk", "run", "build"],
    {
      cwd: resolve(runtimeRoot, ".."),
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (res.status !== 0 || !existsSync(resolve(sdkRoot, "dist", "index.js"))) {
    throw new Error("agenc-sdk workspace build failed; runtime bundle cannot resolve @tetsuo-ai/agenc-sdk");
  }
}

async function main() {
  await verifyFreshStateSchemaSources(runtimeRoot);
  ensureSdkWorkspaceBuilt();
  const config = normalizeConfig(await loadConfig());
  await runBundle(config);
  const nativeBuild = spawnSync(
    process.execPath,
    [resolve(distDir, "bin/prepare-peer-credentials.js"), "--build"],
    { cwd: runtimeRoot, stdio: "inherit" },
  );
  if (nativeBuild.error !== undefined || nativeBuild.status !== 0) {
    throw new Error("peer credential native binding build failed", {
      cause: nativeBuild.error,
    });
  }
  runDeclarations();
}

main().catch((error) => {
  console.error("[build] failed:", error);
  process.exitCode = 1;
});
