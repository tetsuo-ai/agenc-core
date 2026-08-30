#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  EVAL_CONTRACT_VERSION,
  classifyLegacyEvalReport,
  validateEvalContractDocument,
} from "./index.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/**
 * Read one evaluation document as a regular, non-symlink file of bounded
 * size. The open never follows a symlink and never blocks on a FIFO or
 * device, and the object identity is checked before and after the read so a
 * swapped or growing file is rejected instead of half-read.
 */
async function readBoundedJson(file: string): Promise<unknown> {
  const pathBefore = await lstat(file, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(`${file} must be a regular non-symlink file`);
  }
  if (pathBefore.size > BigInt(MAX_DOCUMENT_BYTES)) {
    throw new Error(`evaluation document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(file, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size
    ) {
      throw new Error("evaluation document changed before it could be opened");
    }
    // Read one byte past the observed size so growth during the read is
    // detected instead of silently truncated.
    const expectedBytes = Number(before.size);
    const buffer = Buffer.allocUnsafe(expectedBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        byteLength,
        buffer.byteLength - byteLength,
        byteLength,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      BigInt(byteLength) !== before.size
    ) {
      throw new Error("evaluation document changed while it was being read");
    }
    return JSON.parse(buffer.subarray(0, byteLength).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function usage(): never {
  process.stderr.write(
    "Usage: npm --workspace=@tetsuo-ai/runtime run check:eval-contract -- [--legacy] [--json] <document.json> [...]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  // Options end at the first "--"; everything after it is a file name, so a
  // document whose name starts with a dash can still be checked. Any other
  // dash-prefixed argument that is not a known flag is a usage error.
  const separator = arguments_.indexOf("--");
  const optionArguments = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  const trailingFiles = separator === -1 ? [] : arguments_.slice(separator + 1);
  const legacy = optionArguments.includes("--legacy");
  const json = optionArguments.includes("--json");
  const files = [
    ...optionArguments.filter((argument) => !argument.startsWith("-")),
    ...trailingFiles,
  ];
  if (files.length === 0 || optionArguments.some((argument) =>
    argument.startsWith("-") && argument !== "--legacy" && argument !== "--json")) {
    usage();
  }
  const results: Array<Record<string, unknown>> = [];
  let failed = false;
  for (const file of files) {
    const resolved = path.resolve(file);
    try {
      const value = await readBoundedJson(resolved);
      if (legacy) {
        const qualification = classifyLegacyEvalReport(value);
        results.push({ file: resolved, valid: true, ...qualification });
      } else {
        const document = validateEvalContractDocument(value);
        results.push({
          file: resolved,
          valid: true,
          contractVersion: EVAL_CONTRACT_VERSION,
          kind: document.kind,
          verificationScope: "standalone_document",
          ...(document.kind === "agenc.eval.derived-summary"
            ? {
              claimVerified: false,
              requiredValidator: "validateDerivedSummaryAgainstBundle",
            }
            : {}),
        });
      }
    } catch (error) {
      failed = true;
      results.push({
        file: resolved,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ contractVersion: EVAL_CONTRACT_VERSION, results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      const status = result.valid ? "ok" : "invalid";
      const suffix = result.valid
        ? ` (${String(result.kind ?? result.classification)})${
          result.claimVerified === false ? " [claim requires bundle validation]" : ""
        }`
        : `: ${String(result.error)}`;
      process.stdout.write(`${status} ${String(result.file)}${suffix}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
