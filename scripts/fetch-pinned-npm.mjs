#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_NPM_ARCHIVE_BYTES = 32 * 1024 * 1024;

async function readBoundedBody(response, maximumBytes = MAX_NPM_ARCHIVE_BYTES) {
  const reader = response.body?.getReader?.();
  if (reader === undefined) throw new Error("pinned npm response has no readable body");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new Error("pinned npm response emitted an invalid body chunk");
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("pinned npm response exceeded the byte limit");
        throw new Error(`pinned npm download exceeds ${maximumBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPinnedNpm({
  output,
  fetchImpl = globalThis.fetch,
  toolchainPath = resolve(repoRoot, "release-toolchain.json"),
} = {}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new TypeError("an output path is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");
  const contract = JSON.parse(readFileSync(toolchainPath, "utf8"));
  const npm = contract.npmDistribution;
  if (typeof npm?.url !== "string" || typeof npm.file !== "string" ||
      !/^[0-9a-f]{64}$/.test(npm.sha256 ?? "")) {
    throw new Error("release-toolchain.json has an invalid npm distribution");
  }
  const expectedUrl = new URL(npm.url);
  if (expectedUrl.protocol !== "https:" || expectedUrl.hostname !== "registry.npmjs.org" ||
      expectedUrl.pathname !== `/npm/-/${npm.file}`) {
    throw new Error("pinned npm distribution must be the canonical HTTPS npm registry tarball");
  }
  const response = await fetchImpl(expectedUrl, { redirect: "error" });
  if (!response.ok || response.url !== expectedUrl.href) {
    throw new Error(`pinned npm download failed without redirects: HTTP ${response.status}`);
  }
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
  if (declaredLength !== undefined &&
      (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 ||
        declaredLength > MAX_NPM_ARCHIVE_BYTES)) {
    throw new Error(`pinned npm download has an invalid content length: ${declaredLength}`);
  }
  const bytes = await readBoundedBody(response);
  if (bytes.length === 0 ||
      (declaredLength !== undefined && bytes.length !== declaredLength)) {
    throw new Error("pinned npm download byte count is invalid");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== npm.sha256) {
    throw new Error(`pinned npm sha256 mismatch: ${digest} != ${npm.sha256}`);
  }
  const destination = resolve(output);
  let descriptor;
  let directoryDescriptor;
  let created = false;
  let committed = false;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    directoryDescriptor = openSync(dirname(destination), "r");
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
    committed = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    if (created && !committed) rmSync(destination, { force: true });
  }
  return { output: destination, bytes: bytes.length, sha256: digest, version: contract.npmVersion };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const output = process.argv[2];
  await fetchPinnedNpm({ output }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
