#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  Z_PURGEC_TSCONFIG_BOUNDARY_END,
  Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT,
  Z_PURGEC_TSCONFIG_BOUNDARY_START,
  collectRuntimeUpstreamReferences,
  disallowedZPurgecTypecheckExcludes,
  extractMarkedZPurgecTsconfigBoundary,
  extractRuntimeTsconfigExcludes,
  validateZPurgecTsconfigBoundary,
} from "./purge-scans.mjs";

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } else {
    process.stderr.write(`✗ ${name}\n`);
    if (detail) process.stderr.write(`    ${detail}\n`);
    failed += 1;
  }
}

function writeFixture(root, rel, source) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, source);
}

const root = mkdtempSync(path.join(tmpdir(), "agenc-purge-scans-"));

try {
  const files = [
    "runtime/src/live.ts",
    "runtime/tests/live.test.ts",
    "runtime/tsconfig.json",
    "runtime/tsup.config.ts",
    "runtime/src/agenc/upstream/mirror.ts",
    "runtime/src/clean.ts",
  ];
  writeFixture(root, "runtime/src/live.ts", 'import "../agenc/upstream/bootstrap/state.js";\n');
  writeFixture(root, "runtime/tests/live.test.ts", 'const p = "runtime/src/agenc/upstream/tools/Tool.ts";\n');
  writeFixture(root, "runtime/tsconfig.json", '{ "exclude": ["src/agenc/upstream/**/*"] }\n');
  writeFixture(root, "runtime/tsup.config.ts", 'const stale = "agenc/upstream/services/api/client";\n');
  writeFixture(root, "runtime/src/agenc/upstream/mirror.ts", 'const allowed = "agenc/upstream/internal";\n');
  writeFixture(root, "runtime/src/clean.ts", 'const ok = "agenc/runtime";\n');

  const stale = collectRuntimeUpstreamReferences({ root, files });
  assert(
    "scanner detects stale references in runtime source, tests, tsconfig, and tsup",
    stale.length === 4 &&
      stale.some((line) => line.startsWith("runtime/src/live.ts:")) &&
      stale.some((line) => line.startsWith("runtime/tests/live.test.ts:")) &&
      stale.some((line) => line.startsWith("runtime/tsconfig.json:")) &&
      stale.some((line) => line.startsWith("runtime/tsup.config.ts:")),
    stale.join("\n"),
  );
  assert(
    "scanner ignores the upstream mirror path itself",
    !stale.some((line) => line.startsWith("runtime/src/agenc/upstream/mirror.ts:")),
    stale.join("\n"),
  );
  assert(
    "scanner reports clean success as an empty list",
    collectRuntimeUpstreamReferences({ root, files: ["runtime/src/clean.ts"] }).length === 0,
  );

  const tsconfig = `{
    "exclude": [
      "node_modules",
      "src/bootstrap/**/*",
      "src/query.ts",
      "src/constants/**/*"
    ]
  }`;
  assert(
    "tsconfig parser returns exclude entries",
    extractRuntimeTsconfigExcludes(tsconfig).join(",") ===
      "node_modules,src/bootstrap/**/*,src/query.ts,src/constants/**/*",
  );
  assert(
    "Z-PURGEC tsconfig scan rejects migrated broad roots but leaves concrete files and earlier baselines alone",
    disallowedZPurgecTypecheckExcludes(tsconfig).join(",") ===
      "src/bootstrap/**/*",
  );

  const boundaryEntries = Array.from(
    { length: Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT },
    (_value, index) => `src/services/file-${index}.ts`,
  );
  const exactBoundary = `{
    "exclude": [
      "node_modules",
      ${Z_PURGEC_TSCONFIG_BOUNDARY_START}
      ${boundaryEntries.map((entry) => JSON.stringify(entry)).join(",\n      ")},
      ${Z_PURGEC_TSCONFIG_BOUNDARY_END}
      "src/constants/**/*"
    ]
  }`;
  assert(
    "Z-PURGEC tsconfig marker parser returns the exact marker block",
    extractMarkedZPurgecTsconfigBoundary(exactBoundary).length ===
      Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT,
  );
  assert(
    "Z-PURGEC tsconfig validator accepts the exact bounded marker block",
    validateZPurgecTsconfigBoundary(exactBoundary).issues.length === 0,
  );
  const broadOutsideBoundary = exactBoundary.replace(
    '"src/constants/**/*"',
    '"src/tools/**/*"',
  );
  assert(
    "Z-PURGEC tsconfig validator rejects broad migrated roots anywhere in the exclude list",
    validateZPurgecTsconfigBoundary(broadOutsideBoundary).issues.some((issue) =>
      issue.includes("excludes migrated Z-PURGEC roots"),
    ),
  );
  const grownBoundary = exactBoundary.replace(
    Z_PURGEC_TSCONFIG_BOUNDARY_END,
    `${JSON.stringify("src/services/extra.ts")},\n      ${Z_PURGEC_TSCONFIG_BOUNDARY_END}`,
  );
  assert(
    "Z-PURGEC tsconfig validator rejects boundary entry growth",
    validateZPurgecTsconfigBoundary(grownBoundary).issues.some((issue) =>
      issue.includes(`expected ${Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT}`),
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
