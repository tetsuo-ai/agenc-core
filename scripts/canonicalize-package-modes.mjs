#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const packageRoot = resolve(process.argv[2] ?? ".");
const packagePath = resolve(packageRoot, "package.json");
if (!existsSync(packagePath)) {
  throw new Error(`package.json not found beneath ${packageRoot}`);
}
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
if (!Array.isArray(pkg.files) || pkg.files.some((entry) => typeof entry !== "string" || /[*?![\]{}]/.test(entry))) {
  throw new Error(`${pkg.name ?? packageRoot} must use an explicit, non-glob files list`);
}

const executablePaths = new Set();
const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
for (const path of Object.values(bins)) {
  if (typeof path !== "string") throw new Error(`${pkg.name} has an invalid bin mapping`);
  executablePaths.add(path.replace(/^\.\//, "").split("/").join(sep));
}

const payloadRoots = new Set(["package.json", ...pkg.files]);
for (const name of readdirSync(packageRoot)) {
  if (/^(readme|license|licence|changelog)(?:\..*)?$/i.test(name)) payloadRoots.add(name);
}

function visit(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) visit(resolve(path, name));
    return;
  }
  if (!metadata.isFile()) throw new Error(`unsupported package payload entry: ${path}`);
  const rel = relative(packageRoot, path);
  chmodSync(path, executablePaths.has(rel) ? 0o755 : 0o644);
}

for (const entry of [...payloadRoots].sort()) {
  const path = resolve(packageRoot, entry);
  if (path !== packageRoot && !path.startsWith(`${packageRoot}${sep}`)) {
    throw new Error(`package payload escapes package root: ${entry}`);
  }
  if (existsSync(path)) visit(path);
}

process.stdout.write(
  `[package modes] ${pkg.name ?? basename(packageRoot)}: files=0644 dirs/bins=0755\n`,
);
