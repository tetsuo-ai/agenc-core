#!/usr/bin/env node
// Contract tests for scripts/check-sibling-package-pins.mjs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildPinStalenessReport,
  collectPinnedTetsuoDependencies,
  compareVersions,
  isExactVersion,
} from "./check-sibling-package-pins.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-sibling-package-pins.mjs",
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
  const root = mkdtempSync(path.join(tmpdir(), "agenc-pin-gate-"));
  writePackage(root, "package.json", {
    name: "umbrella",
    private: true,
  });
  writePackage(root, "repo-a/package.json", {
    name: "repo-a",
    dependencies: {
      "@tetsuo-ai/sdk": "1.3.1",
      "@tetsuo-ai/plugin-kit": "file:../agenc-plugin-kit",
      react: "^19.0.0",
    },
    devDependencies: {
      "@tetsuo-ai/protocol": "0.2.0",
    },
  });
  writePackage(root, "repo-a/node_modules/ignored/package.json", {
    dependencies: {
      "@tetsuo-ai/sdk": "0.1.0",
    },
  });
  writePackage(root, "repo-b/tools/package.json", {
    name: "repo-b-tools",
    devDependencies: {
      "@tetsuo-ai/sdk": "1.4.0",
      "@tetsuo-ai/protocol": "0.1.1",
    },
  });
  return root;
}

function writePackage(root, rel, body) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function runChecker(root, latest) {
  const latestJson = path.join(root, "latest.json");
  writeFileSync(latestJson, `${JSON.stringify(latest, null, 2)}\n`);
  return spawnSync(
    process.execPath,
    [scriptPath, "--root", root, "--latest-json", latestJson],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

try {
  assert("exact version accepts plain semver", isExactVersion("1.2.3"));
  assert("exact version rejects ranges", !isExactVersion("^1.2.3"));
  assert("exact version rejects file specs", !isExactVersion("file:../pkg"));
  assert("version compare detects older", compareVersions("1.3.1", "1.4.0") < 0);
  assert("version compare detects equal", compareVersions("1.4.0", "1.4.0") === 0);

  const root = createFixture();
  try {
    const pins = collectPinnedTetsuoDependencies(root);
    assert(
      "collector includes exact scoped pins outside node_modules",
      pins.map((pin) => `${pin.field}:${pin.name}:${pin.spec}`).join(",") ===
        [
          "dependencies:@tetsuo-ai/sdk:1.3.1",
          "devDependencies:@tetsuo-ai/protocol:0.2.0",
          "devDependencies:@tetsuo-ai/sdk:1.4.0",
          "devDependencies:@tetsuo-ai/protocol:0.1.1",
        ].join(","),
    );

    const report = buildPinStalenessReport({
      root,
      latestVersions: new Map([
        ["@tetsuo-ai/sdk", "1.4.0"],
        ["@tetsuo-ai/protocol", "0.2.0"],
      ]),
    });
    assert("report checks four exact pins", report.checkedPins === 4);
    assert("report finds two stale pins", report.stalePins.length === 2);
    assert(
      "report includes clear fix command",
      report.stalePins[0].fixCommand.includes(
        "npm install @tetsuo-ai/sdk@1.4.0 --save-exact --save-prod",
      ),
      report.stalePins[0]?.fixCommand,
    );

    const cli = runChecker(root, {
      "@tetsuo-ai/sdk": "1.4.0",
      "@tetsuo-ai/protocol": "0.2.0",
    });
    assert("CLI exits 0 while warning", cli.status === 0, cli.stderr);
    assert(
      "CLI prints warning per stale pin",
      cli.stdout.includes("repo-a/package.json") &&
        cli.stdout.includes("repo-b/tools/package.json") &&
        cli.stdout.includes("latest published is 1.4.0") &&
        cli.stdout.includes("latest published is 0.2.0"),
      cli.stdout,
    );

    const clean = runChecker(root, {
      "@tetsuo-ai/sdk": "1.3.1",
      "@tetsuo-ai/protocol": "0.1.1",
    });
    assert("CLI reports clean pins", clean.stdout.includes("no stale pins found"), clean.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (error) {
  assert("unexpected test exception", false, error.message);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
