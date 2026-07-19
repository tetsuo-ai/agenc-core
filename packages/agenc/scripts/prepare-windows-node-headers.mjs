#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_LINE = Buffer.from(
  "        'DebugInformationFormat': 1,          # /Z7 embed info in .obj files\n",
);
const RELEASE_LINE = Buffer.from(
  "        'DebugInformationFormat': 0,          # disabled for reproducible release objects\n",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function prepareWindowsCommonGypiBytes(source, contract) {
  const sourceSha256 = sha256(source);
  if (sourceSha256 === contract.releaseSha256) {
    return { bytes: source, changed: false, sourceSha256, releaseSha256: sourceSha256 };
  }
  if (sourceSha256 !== contract.sourceSha256) {
    throw new Error(
      `Node common.gypi source digest mismatch: ${sourceSha256} != ${contract.sourceSha256}`,
    );
  }
  const offset = source.indexOf(SOURCE_LINE);
  if (offset < 0 || source.indexOf(SOURCE_LINE, offset + 1) >= 0) {
    throw new Error("Node common.gypi must contain exactly one pinned /Z7 setting");
  }
  const bytes = Buffer.concat([
    source.subarray(0, offset),
    RELEASE_LINE,
    source.subarray(offset + SOURCE_LINE.length),
  ]);
  const releaseSha256 = sha256(bytes);
  if (releaseSha256 !== contract.releaseSha256) {
    throw new Error(
      `sanitized Node common.gypi digest mismatch: ${releaseSha256} != ${contract.releaseSha256}`,
    );
  }
  return { bytes, changed: true, sourceSha256, releaseSha256 };
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function main() {
  const root = argument("root");
  if (!isAbsolute(root)) throw new Error("--root must be absolute");
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const releaseToolchain = JSON.parse(
    readFileSync(join(repoRoot, "release-toolchain.json"), "utf8"),
  );
  const contract = releaseToolchain.nodeHeaders?.windowsCommonGypi;
  if (
    contract?.schemaVersion !== 1 ||
    contract.path !== "include/node/common.gypi" ||
    contract.transformation !== "debug-information-format-none" ||
    !/^[0-9a-f]{64}$/.test(contract.sourceSha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(contract.releaseSha256 ?? "")
  ) {
    throw new Error("release-toolchain Windows common.gypi contract is invalid");
  }
  const path = join(root, ...contract.path.split("/"));
  const mode = statSync(path).mode & 0o777;
  const result = prepareWindowsCommonGypiBytes(readFileSync(path), contract);
  if (result.changed) {
    writeFileSync(path, result.bytes);
    chmodSync(path, mode);
  }
  process.stdout.write(`${JSON.stringify({
    path: contract.path,
    sourceSha256: contract.sourceSha256,
    sha256: result.releaseSha256,
    transformation: contract.transformation,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
