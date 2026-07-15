#!/usr/bin/env node

import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  EVAL_CONTRACT_VERSION,
  classifyLegacyEvalReport,
  validateEvalContractDocument,
} from "./index.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

async function readBoundedJson(file: string): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_DOCUMENT_BYTES) {
      throw new Error(`evaluation document exceeds ${MAX_DOCUMENT_BYTES} bytes or is not a regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      throw new Error("evaluation document changed while it was being read");
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
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
  const legacy = arguments_.includes("--legacy");
  const json = arguments_.includes("--json");
  const files = arguments_.filter((argument) => !argument.startsWith("--"));
  if (files.length === 0 || arguments_.some((argument) =>
    argument.startsWith("--") && argument !== "--legacy" && argument !== "--json")) {
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
