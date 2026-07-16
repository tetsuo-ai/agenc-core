#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  EVAL_SUITE_PROTOCOL_VERSION,
  assertReleasedEvalSuiteCatalog,
  loadAndValidateEvalSuiteCatalog,
} from "./index.js";

function usage(): never {
  process.stderr.write(
    "Usage: npm --workspace=@tetsuo-ai/runtime run check:eval-suites -- [--json] [catalog.json]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes("--json");
  const paths = arguments_.filter((argument) => !argument.startsWith("--"));
  if (
    paths.length > 1 ||
    arguments_.some((argument) => argument.startsWith("--") && argument !== "--json")
  ) {
    usage();
  }
  const catalogPath = path.resolve(paths[0] ?? "eval/suites/catalog.json");
  try {
    const validated = assertReleasedEvalSuiteCatalog(
      await loadAndValidateEvalSuiteCatalog(catalogPath),
    );
    const result = {
      valid: true,
      suiteProtocolVersion: EVAL_SUITE_PROTOCOL_VERSION,
      catalog: {
        id: validated.catalog.catalogId,
        version: validated.catalog.catalogVersion,
        digest: validated.catalog.documentDigest,
      },
      definitions: [validated.competitive, validated.trust].map((definition) => ({
        kind: definition.kind,
        suiteClass: definition.suiteClass,
        suiteId: definition.suiteId,
        suiteVersion: definition.suiteVersion,
        digest: definition.documentDigest,
        reportKind: definition.reporting.kind,
      })),
    };
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` :
      `evaluation suite catalog ok (${result.catalog.id}@${result.catalog.version}; 2 definitions)\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ valid: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
