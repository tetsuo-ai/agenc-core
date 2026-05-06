#!/usr/bin/env node
// Contract tests for scripts/check-bin-classification.mjs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  compareBinClassification,
  directBinImportsFromSource,
  discoverBinSourceFiles,
  findSideDependencyContradictions,
  isProductionBinSourceFile,
  parseMigrationInventory,
} from "./check-bin-classification.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-bin-classification.mjs",
);

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

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-bin-classification-"));
  const binDir = path.join(root, "runtime/src/bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "agenc.ts"), "export const cli = true;\n");
  writeFileSync(path.join(binDir, "route.ts"), "export const parse = true;\n");
  writeFileSync(
    path.join(binDir, "bootstrap.ts"),
    `import { parse } from "./route.js";\nexport const boot = parse;\n`,
  );
  mkdirSync(path.join(binDir, "_deps"), { recursive: true });
  writeFileSync(
    path.join(binDir, "_deps/current-session.ts"),
    "export const current = true;\n",
  );
  writeFileSync(path.join(binDir, "agenc.test.ts"), "export const test = true;\n");
  writeFileSync(
    path.join(binDir, "daemon-autostart.contract.test.ts"),
    "export const test = true;\n",
  );
  return root;
}

function writeMigration(root, markdown) {
  writeFileSync(path.join(root, "runtime/src/bin/MIGRATION.md"), markdown);
}

function runChecker(root) {
  return spawnSync(process.execPath, [scriptPath, "--root", root], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  assert("accepts production .ts", isProductionBinSourceFile("agenc.ts"));
  assert("rejects unit tests", !isProductionBinSourceFile("agenc.test.ts"));
  assert(
    "rejects contract tests",
    !isProductionBinSourceFile("daemon-autostart.contract.test.ts"),
  );

  const parsed = parseMigrationInventory(`
| File | Side | Notes |
| --- | --- | --- |
| \`runtime/src/bin/_deps/current-session.ts\` | shared | state |
| \`runtime/src/bin/agenc.ts\` | client-only | entry |
| \`runtime/src/bin/route.ts\` | shared | route |
| \`runtime/src/bin/bootstrap.ts\` | shared | runtime |
`);
  assert(
    "parser reads migration table rows",
    parsed.length === 4 && parsed[3]?.classification === "shared",
    JSON.stringify(parsed),
  );
  assert(
    "import parser resolves direct bin dependencies",
    directBinImportsFromSource(
      "runtime/src/bin/bootstrap.ts",
      `import { parse } from "./route.js";\n`,
    ).join(",") === "runtime/src/bin/route.ts",
  );

  const root = createFixture();
  try {
    const sourceFiles = discoverBinSourceFiles(root);
    assert(
      "discovery recurses and ignores test files",
      sourceFiles.join(",") ===
        "runtime/src/bin/_deps/current-session.ts,runtime/src/bin/agenc.ts,runtime/src/bin/bootstrap.ts,runtime/src/bin/route.ts",
      sourceFiles.join(","),
    );

    const clean = compareBinClassification({
      sourceFiles,
      entries: parsed,
    });
    assert("complete classification passes", clean.ok, JSON.stringify(clean));

    const missing = compareBinClassification({
      sourceFiles,
      entries: parsed.filter((entry) => entry.relPath !== "runtime/src/bin/bootstrap.ts"),
    });
    assert(
      "missing row is reported",
      !missing.ok && missing.missing.includes("runtime/src/bin/bootstrap.ts"),
      JSON.stringify(missing),
    );

    const invalid = compareBinClassification({
      sourceFiles,
      entries: [
        {
          relPath: "runtime/src/bin/_deps/current-session.ts",
          classification: "shared",
        },
        { relPath: "runtime/src/bin/agenc.ts", classification: "client-only" },
        { relPath: "runtime/src/bin/route.ts", classification: "shared" },
        { relPath: "runtime/src/bin/bootstrap.ts", classification: "other" },
      ],
    });
    assert(
      "invalid side is reported",
      !invalid.ok && invalid.invalid[0]?.classification === "other",
      JSON.stringify(invalid),
    );

    const extra = compareBinClassification({
      sourceFiles,
      entries: [
        ...parsed,
        { relPath: "runtime/src/bin/removed.ts", classification: "shared" },
      ],
    });
    assert(
      "extra row is reported",
      !extra.ok && extra.extra.includes("runtime/src/bin/removed.ts"),
      JSON.stringify(extra),
    );

    const duplicate = compareBinClassification({
      sourceFiles,
      entries: [...parsed, parsed[0]],
    });
    assert(
      "duplicate row is reported",
      !duplicate.ok &&
        duplicate.duplicates.includes("runtime/src/bin/_deps/current-session.ts"),
      JSON.stringify(duplicate),
    );

    const contradictionEntries = parsed.map((entry) =>
      entry.relPath === "runtime/src/bin/route.ts"
        ? { ...entry, classification: "client-only" }
        : entry,
    );
    const contradictions = findSideDependencyContradictions(
      root,
      contradictionEntries,
    );
    assert(
      "shared-to-client dependency contradiction is reported",
      contradictions.length === 1 &&
        contradictions[0]?.from === "runtime/src/bin/bootstrap.ts" &&
        contradictions[0]?.to === "runtime/src/bin/route.ts",
      JSON.stringify(contradictions),
    );

    writeMigration(
      root,
      `
| File | Side | Notes |
| --- | --- | --- |
| \`runtime/src/bin/_deps/current-session.ts\` | shared | state |
| \`runtime/src/bin/agenc.ts\` | client-only | entry |
| \`runtime/src/bin/route.ts\` | shared | route |
| \`runtime/src/bin/bootstrap.ts\` | shared | runtime |
`,
    );
    const passingCli = runChecker(root);
    assert(
      "CLI passes complete migration",
      passingCli.status === 0,
      `${passingCli.stderr}${passingCli.stdout}`,
    );

    writeMigration(
      root,
      `
| File | Side | Notes |
| --- | --- | --- |
| \`runtime/src/bin/agenc.ts\` | client-only | entry |
| \`runtime/src/bin/route.ts\` | shared | route |
| \`runtime/src/bin/bootstrap.ts\` | shared | runtime |
`,
    );
    const failingCli = runChecker(root);
    assert(
      "CLI fails incomplete recursive migration",
      failingCli.status === 1 &&
        failingCli.stderr.includes("runtime/src/bin/_deps/current-session.ts"),
      `${failingCli.stderr}${failingCli.stdout}`,
    );

    writeMigration(
      root,
      `
| File | Side | Notes |
| --- | --- | --- |
| \`runtime/src/bin/_deps/current-session.ts\` | shared | state |
| \`runtime/src/bin/agenc.ts\` | client-only | entry |
| \`runtime/src/bin/route.ts\` | client-only | route |
| \`runtime/src/bin/bootstrap.ts\` | shared | runtime |
`,
    );
    const contradictionCli = runChecker(root);
    assert(
      "CLI fails shared-to-client dependency contradiction",
      contradictionCli.status === 1 &&
        contradictionCli.stderr.includes("runtime/src/bin/bootstrap.ts") &&
        contradictionCli.stderr.includes("runtime/src/bin/route.ts"),
      `${contradictionCli.stderr}${contradictionCli.stdout}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (error) {
  assert("unexpected test exception", false, error.message);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
