#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runtimeArchiveContentInventory } from "../lib/runtime-archive.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing --${name}`);
  return resolve(process.argv[index + 1]);
}

const first = argument("first");
const second = argument("second");
const output = argument("output");

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === "" || (
    !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)
  );
}

function assertDisjointPaths() {
  if (
    containsPath(first, second) || containsPath(second, first) ||
    containsPath(first, output) || containsPath(output, first) ||
    containsPath(second, output) || containsPath(output, second)
  ) {
    throw new Error("reproducible artifact input and output directories must be disjoint");
  }
}

function prepareOutput() {
  if (!existsSync(output)) {
    mkdirSync(output, { mode: 0o700 });
    return;
  }
  const metadata = lstatSync(output);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`artifact output must be a plain directory: ${output}`);
  }
  if (readdirSync(output).length !== 0) {
    throw new Error(`artifact output must be empty: ${output}`);
  }
}

function inventory(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`artifact directory not found: ${root}`);
  }
  return readdirSync(root)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((name) => {
      const path = join(root, name);
      if (!lstatSync(path).isFile() || !/\.(?:tar\.gz|meta\.json)$/.test(name)) {
        throw new Error(`unexpected artifact output: ${path}`);
      }
      const bytes = readFileSync(path);
      return {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
}

function validateArtifactPair(root, entries) {
  const tarballs = entries.filter((entry) => entry.name.endsWith(".tar.gz"));
  const sidecars = entries.filter((entry) => entry.name.endsWith(".meta.json"));
  if (tarballs.length !== 1 || sidecars.length !== 1 || entries.length !== 2) {
    throw new Error(`expected exactly one runtime tarball and one sidecar, got ${entries.length}`);
  }
  const tarball = tarballs[0];
  const sidecar = sidecars[0];
  if (sidecar.name !== `${tarball.name}.meta.json`) {
    throw new Error(`provenance sidecar is detached from ${tarball.name}: ${sidecar.name}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(join(root, sidecar.name), "utf8"));
  } catch (error) {
    throw new Error(`provenance sidecar is invalid JSON: ${sidecar.name}`, { cause: error });
  }
  if (
    metadata?.artifact !== tarball.name ||
    metadata.sha256 !== tarball.sha256 ||
    metadata.bytes !== tarball.bytes ||
    metadata.artifactProfile !== "release" ||
    metadata.nativeToolchain === null ||
    typeof metadata.nativeToolchain !== "object" ||
    Array.isArray(metadata.nativeToolchain)
  ) {
    throw new Error(`provenance sidecar does not bind the release tarball: ${sidecar.name}`);
  }
}

function archiveEntryDifferences(leftEntries, rightEntries) {
  const leftTarball = leftEntries.find((entry) => entry.name.endsWith(".tar.gz"));
  const rightTarball = rightEntries.find((entry) => entry.name.endsWith(".tar.gz"));
  if (!leftTarball || !rightTarball || leftTarball.name !== rightTarball.name) {
    return { count: 0, shown: [], unavailable: "release tarball names differ" };
  }
  try {
    const left = runtimeArchiveContentInventory(join(first, leftTarball.name));
    const right = runtimeArchiveContentInventory(join(second, rightTarball.name));
    const leftByPath = new Map(left.members.map((member) => [member.path, member]));
    const rightByPath = new Map(right.members.map((member) => [member.path, member]));
    const paths = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const differences = paths.flatMap((path) => {
      const leftMember = leftByPath.get(path);
      const rightMember = rightByPath.get(path);
      return JSON.stringify(leftMember) === JSON.stringify(rightMember)
        ? []
        : [{ path, first: leftMember ?? null, second: rightMember ?? null }];
    });
    return {
      count: differences.length,
      shown: differences.slice(0, 50),
      ...(differences.length > 50 ? { omitted: differences.length - 50 } : {}),
    };
  } catch (error) {
    return {
      count: 0,
      shown: [],
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

assertDisjointPaths();
const left = inventory(first);
const right = inventory(second);
validateArtifactPair(first, left);
validateArtifactPair(second, right);
if (JSON.stringify(left) !== JSON.stringify(right)) {
  const entryDifferences = archiveEntryDifferences(left, right);
  throw new Error(
    `two release builds were not byte-identical:\nfirst=${JSON.stringify(left, null, 2)}\n` +
      `second=${JSON.stringify(right, null, 2)}\n` +
      `archiveEntryDifferences=${JSON.stringify(entryDifferences, null, 2)}`,
  );
}

prepareOutput();
for (const entry of left) copyFileSync(join(first, entry.name), join(output, basename(entry.name)));
process.stdout.write(`verified byte-identical release outputs: ${left.map((entry) => entry.name).join(", ")}\n`);
