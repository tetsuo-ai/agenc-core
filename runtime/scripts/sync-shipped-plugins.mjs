#!/usr/bin/env node
/**
 * Copy the repository's first-party `plugins/` into the runtime package so it
 * ships to installed users.
 *
 * `plugins/` deliberately stays at the REPO root: `discoverPluginRoots` looks
 * under `<workspaceRoot>/plugins` and `<gitRoot>/plugins`, so moving it under
 * runtime/ would stop it being found by anyone who opens this repo as their
 * workspace. Copying at build time keeps both audiences working from one
 * source of truth.
 *
 * The copy is a build artifact, not source — it is gitignored, and it is
 * rebuilt from scratch each time so a plugin deleted upstream cannot linger
 * inside the package.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(runtimeRoot, "..", "plugins");
const target = join(runtimeRoot, "plugins");

if (!existsSync(source)) {
  console.log("[shipped plugins] no repo plugins/ directory — nothing to sync");
  process.exit(0);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const names = [];
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  await cp(join(source, entry.name), join(target, entry.name), {
    recursive: true,
    dereference: true,
  });
  names.push(entry.name);
}

// A plugin that ships without its SKILL.md registers as an empty entry in
// /plugin, so fail the build rather than publish one.
for (const name of names) {
  const skill = join(target, name, "skills", name, "SKILL.md");
  if (!existsSync(skill)) continue;
  const info = await stat(skill);
  if (info.size === 0) {
    console.error(`[shipped plugins] ${name}: SKILL.md is empty`);
    process.exit(1);
  }
}

console.log(
  `[shipped plugins] synced ${names.length}: ${names.join(", ") || "(none)"}`,
);
