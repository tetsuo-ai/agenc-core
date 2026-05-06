#!/usr/bin/env node
// Contract tests for scripts/check-upstream-import-growth.mjs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  compareImporterSets,
  hasUnexemptedUpstreamImport,
  importerFilesFromGitGrepOutput,
  importerFilesFromRipgrepOutput,
  isProductionTypeScriptPath,
} from "./check-upstream-import-growth.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-upstream-import-growth.mjs",
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

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function runChecker(root) {
  return spawnSync(process.execPath, [scriptPath, "--root", root], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-upstream-import-gate-"));
  mkdirSync(path.join(root, "runtime/src/agenc/upstream"), { recursive: true });
  writeFileSync(
    path.join(root, "runtime/src/existing.ts"),
    `import { existing } from "./agenc/upstream/existing.js";\nexport { existing };\n`,
  );
  writeFileSync(
    path.join(root, "runtime/src/existing-require.ts"),
    `const existing = require("./agenc/upstream/existing-require.js");\nexport { existing };\n`,
  );
  writeFileSync(
    path.join(root, "runtime/src/existing-array.ts"),
    `const specifier = ["..", "agenc", "upstream", "existing.js"].join("/");\nexport { specifier };\n`,
  );
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@localhost"]);
  runGit(root, ["config", "user.name", "AgenC Test"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "baseline"]);
  return root;
}

try {
  assert(
    "production path accepts runtime TypeScript",
    isProductionTypeScriptPath("runtime/src/agent.ts"),
  );
  assert(
    "production path rejects tests",
    !isProductionTypeScriptPath("runtime/src/agent.test.ts"),
  );
  assert(
    "ripgrep output filters test files",
    importerFilesFromRipgrepOutput(
      "runtime/src/agent.ts\nruntime/src/agent.test.ts\n",
    ).join(",") === "runtime/src/agent.ts",
  );
  assert(
    "git grep output strips ref prefix",
    importerFilesFromGitGrepOutput("main:runtime/src/agent.ts\n", "main")[0] ===
      "runtime/src/agent.ts",
  );
  assert(
    "set comparison reports positive growth",
    compareImporterSets(["runtime/src/a.ts"], [
      "runtime/src/a.ts",
      "runtime/src/b.ts",
    ]).delta === 1,
  );
  assert(
    "keep comment exempts upstream import lines",
    !hasUnexemptedUpstreamImport(
      [
        "// upstream-import: keep target is owned by another Z-PURGE item",
        'import { kept } from "./agenc/upstream/kept.js";',
      ].join("\n"),
    ),
  );
  assert(
    "uncommented upstream import lines are counted",
    hasUnexemptedUpstreamImport(
      'import { counted } from "./agenc/upstream/counted.js";',
    ),
  );

  const root = createRepo();
  try {
    const clean = runChecker(root);
    assert(
      "clean candidate passes",
      clean.status === 0,
      `${clean.stderr}${clean.stdout}`,
    );

    writeFileSync(
      path.join(root, "runtime/src/new.test.ts"),
      `import { testOnly } from "./agenc/upstream/test-only.js";\nexport { testOnly };\n`,
    );
    const testOnly = runChecker(root);
    assert(
      "test-only importer is ignored",
      testOnly.status === 0,
      `${testOnly.stderr}${testOnly.stdout}`,
    );

    writeFileSync(
      path.join(root, "runtime/src/kept.ts"),
      [
        "// upstream-import: keep target is owned by another Z-PURGE item",
        'import { kept } from "./agenc/upstream/kept.js";',
        "export { kept };",
      ].join("\n"),
    );
    const kept = runChecker(root);
    assert(
      "kept importer is ignored",
      kept.status === 0,
      `${kept.stderr}${kept.stdout}`,
    );

    writeFileSync(
      path.join(root, "runtime/src/new.ts"),
      `import { added } from "./agenc/upstream/added.js";\nexport { added };\n`,
    );
    const growth = runChecker(root);
    assert(
      "production importer growth fails",
      growth.status === 1,
      `${growth.stderr}${growth.stdout}`,
    );
    assert(
      "failure explains count delta",
      growth.stderr.includes("grew from 3 to 4 (+1)"),
      growth.stderr,
    );
    assert(
      "failure lists new importer",
      growth.stderr.includes("runtime/src/new.ts"),
      growth.stderr,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (error) {
  assert("unexpected test exception", false, error.message);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
