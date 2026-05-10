#!/usr/bin/env node
/**
 * Run React Compiler over AgenC-owned TUI source files and write the
 * compiled output back over the source file. This matches the upstream
 * commit-the-compiled-source workflow: compiled artifacts are checked
 * in with the `import { c as _c } from "react-compiler-runtime"` shim
 * and memo cache slots, the bundler does not re-compile at build time.
 *
 * Usage:
 *   node scripts/compile-react.mjs <path>...
 *
 * Each path may be a file (.ts/.tsx) or a directory. Files already
 * compiled (containing the `c as _c` import) are skipped — the
 * compiler is roughly idempotent but skipping keeps diffs clean and
 * avoids touching the 374 inherited compiled files when this script
 * is re-run.
 */
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { transformAsync } from "@babel/core";

const RUNTIME_RUNTIME_IMPORT =
  'import { c as _c } from "react-compiler-runtime";';

async function compileOne(filePath) {
  const source = await readFile(filePath, "utf8");
  if (source.includes('from "react-compiler-runtime"')) {
    return { filePath, status: "skipped-already-compiled" };
  }
  const ext = extname(filePath);
  const isTsx = ext === ".tsx";
  const isTs = ext === ".ts";
  if (!isTs && !isTsx) {
    return { filePath, status: "skipped-not-ts" };
  }
  const result = await transformAsync(source, {
    filename: filePath,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: {
      plugins: isTsx ? ["typescript", "jsx"] : ["typescript"],
    },
    generatorOpts: {
      retainLines: false,
      compact: false,
    },
    plugins: [
      ["@babel/plugin-syntax-typescript", { isTSX: isTsx }],
      ...(isTsx ? [["@babel/plugin-syntax-jsx"]] : []),
      ["babel-plugin-react-compiler", { target: "19" }],
    ],
  });
  if (!result || typeof result.code !== "string") {
    return { filePath, status: "failed-no-output" };
  }
  if (!result.code.includes('react/compiler-runtime')) {
    return { filePath, status: "no-memoization-needed" };
  }
  // Rewrite the runtime import to the standalone `react-compiler-runtime`
  // package that's already a dep in runtime/package.json — matches the
  // 374 inherited compiled files. The compiler defaults to
  // `react/compiler-runtime` which AgenC's React bundle does not ship.
  const rewritten = result.code.replace(
    /from ["']react\/compiler-runtime["']/g,
    'from "react-compiler-runtime"',
  );
  await writeFile(filePath, rewritten);
  return { filePath, status: "compiled" };
}

async function* walkTsFiles(root) {
  const stats = await stat(root);
  if (stats.isFile()) {
    yield root;
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walkTsFiles(full);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === ".ts" || ext === ".tsx") yield full;
    }
  }
}

async function main(argv) {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: compile-react.mjs <path>...");
    process.exit(2);
  }
  let compiled = 0;
  let skipped = 0;
  let unchanged = 0;
  let failed = 0;
  for (const target of targets) {
    const absolute = resolve(target);
    for await (const file of walkTsFiles(absolute)) {
      try {
        const result = await compileOne(file);
        if (result.status === "compiled") {
          compiled += 1;
          console.log(`compiled: ${file}`);
        } else if (result.status === "no-memoization-needed") {
          unchanged += 1;
        } else if (result.status === "skipped-already-compiled") {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(`failed: ${file}: ${error?.message ?? error}`);
      }
    }
  }
  console.log(
    `[compile-react] compiled=${compiled} unchanged=${unchanged} skipped=${skipped} failed=${failed}`,
  );
  if (failed > 0) process.exit(1);
}

await main(process.argv);
