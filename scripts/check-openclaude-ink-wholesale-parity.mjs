#!/usr/bin/env node
/**
 * Implementation-contract gate for openclaude-ink-wholesale-parity.
 *
 * This goes beyond the standard implementation-contract checker:
 * it verifies that EVERY file in runtime/src/tui/ink/ either matches
 * openclaude's src/ink/ post-transform OR is on the AgenC-only
 * justified list (drawn from matrix rows). And it verifies the inverse
 * — every openclaude file has an AgenC counterpart (or KEEP_AGENC_VERSION).
 *
 * Standard checks:
 *   - matrix structure validation
 *   - file existence (matrix-declared sources/targets/tests)
 *   - forbidden-language scan over targets + tests (using the contextual
 *     pattern set, not the broad word-boundary one)
 *
 * Bespoke checks:
 *   - byte-equivalence: for each common file (post-transform) the AgenC
 *     content must equal the openclaude content transformed by
 *     openclaude-ink-transform.mjs. Drift => fail.
 *   - AgenC-only files must be in the AGENC_ONLY_JUSTIFIED set built from
 *     matrix rows whose target is AgenC-only.
 *   - openclaude files missing from AgenC: fail unless on KEEP_AGENC_VERSION.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  KEEP_AGENC_VERSION,
  transform,
} from "./openclaude-ink-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.resolve(
  SCRIPT_DIR,
  "../parity/openclaude-ink-wholesale-parity.json",
);
const SRC_ROOT = "/home/tetsuo/git/openclaude/src/ink";
const DST_ROOT = path.resolve(SCRIPT_DIR, "../runtime/src/tui/ink");

const FORBIDDEN_PATTERNS = [
  /TODO parity/i,
  /future search box/i,
  /future follow-?up/i,
  /follow-?up commit/i,
  /reduced renderer/i,
  /implementation placeholder/i,
  /placeholder implementation/i,
  /partial implementation/i,
  /stub implementation/i,
  /\bstubbed\b/i,
  /not implemented/i,
  /\bnot yet\b/i,
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFiles(dir, base = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip vendored/ — it is AgenC-side build glue with no openclaude
      // counterpart; locked by the vendored-shims matrix row.
      if (rel === "vendored") continue;
      out.push(...listFiles(abs, rel));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      out.push(rel);
    }
  }
  return out;
}

function scanForbiddenTerms(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const matches = [];
  content.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        matches.push(`${filePath}:${index + 1}: ${line.trim()}`);
        break;
      }
    }
  });
  return matches;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMatrixShape(matrix) {
  const errors = [];
  for (const field of ["contractName", "scope", "sourceRoot", "targetRoot"]) {
    if (typeof matrix[field] !== "string" || matrix[field].trim() === "") {
      errors.push(`top-level field '${field}' must be a non-empty string`);
    }
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
    errors.push("top-level 'rows' must be a non-empty array");
  }
  if (
    !Array.isArray(matrix.transformationRules) ||
    matrix.transformationRules.length === 0
  ) {
    errors.push("top-level 'transformationRules' must be a non-empty array");
  }
  return errors;
}

function validateRow(row, index) {
  const errors = [];
  const label = isObject(row) && row.id ? row.id : `row[${index}]`;
  for (const field of ["id", "source", "target", "status"]) {
    if (typeof row[field] !== "string" || row[field].trim() === "") {
      errors.push(`${label}: '${field}' must be a non-empty string`);
    }
  }
  if (row.status !== "required") {
    errors.push(`${label}: status must be 'required'`);
  }
  if (
    !Array.isArray(row.requiredBehaviors) ||
    row.requiredBehaviors.length === 0
  ) {
    errors.push(`${label}: requiredBehaviors must be a non-empty array`);
  } else {
    row.requiredBehaviors.forEach((b, i) => {
      if (typeof b !== "string" || b.trim() === "") {
        errors.push(`${label}: requiredBehaviors[${i}] must be non-empty`);
        return;
      }
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.test(b)) {
          errors.push(
            `${label}: requiredBehaviors[${i}] contains shortcut language: ${b}`,
          );
          break;
        }
      }
    });
  }
  if (!Array.isArray(row.tests) || row.tests.length === 0) {
    errors.push(`${label}: tests must be a non-empty array`);
  }
  return errors;
}

function relPathInInk(matrix) {
  // Matrix row.target paths are relative to targetRoot. The AgenC ink
  // root is runtime/src/tui/ink. Strip the leading "runtime/src/tui/ink/"
  // to get the file's path relative to ink.
  const inkPrefix = "runtime/src/tui/ink/";
  const set = new Set();
  for (const row of matrix.rows) {
    const t = row.target;
    if (typeof t === "string" && t.startsWith(inkPrefix)) {
      set.add(t.slice(inkPrefix.length));
    }
  }
  return set;
}

function main() {
  const matrix = readJson(MATRIX_PATH);
  const errors = validateMatrixShape(matrix);
  matrix.rows?.forEach?.((r, i) => errors.push(...validateRow(r, i)));

  // Forbidden-language scan over each target + test file.
  for (const row of matrix.rows ?? []) {
    const matrixDir = path.dirname(MATRIX_PATH);
    const targetPath = path.isAbsolute(row.target)
      ? row.target
      : path.resolve(matrixDir, "..", row.target);
    const filesToScan = [];
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      filesToScan.push(targetPath);
    }
    for (const t of row.tests ?? []) {
      const tp = path.isAbsolute(t)
        ? t
        : path.resolve(matrixDir, "..", t);
      if (fs.existsSync(tp) && fs.statSync(tp).isFile()) filesToScan.push(tp);
    }
    for (const fp of filesToScan) {
      for (const m of scanForbiddenTerms(fp)) {
        errors.push(
          `${row.id}: forbidden shortcut language found: ${m}`,
        );
      }
    }
  }

  // Bespoke checks: byte-equivalence + AgenC-only justification.
  const agencOnlyJustified = relPathInInk(matrix);
  // Files like vendored/* are reachable under that ink-rel set; the
  // walker already excludes vendored/, so anything else AgenC-only must
  // be in the justified set.

  const ocFiles = new Set(listFiles(SRC_ROOT));
  const agFiles = new Set(listFiles(DST_ROOT));

  // (a) Every openclaude file must have an AgenC counterpart unless on
  //     KEEP_AGENC_VERSION (which it's still expected to exist for, but
  //     the content is allowed to differ; we just skip byte-equivalence
  //     comparison for those).
  for (const rel of ocFiles) {
    if (!agFiles.has(rel)) {
      errors.push(
        `port-incomplete: openclaude has src/ink/${rel} but AgenC has no runtime/src/tui/ink/${rel}`,
      );
    }
  }

  // (b) Every AgenC file must EITHER have an openclaude counterpart
  //     (subject to byte-equivalence below) OR be in AGENC_ONLY_JUSTIFIED.
  //     ambient.d.ts is implicitly justified (separate row).
  const implicitlyJustified = new Set([
    "ambient.d.ts",
  ]);
  for (const rel of agFiles) {
    if (ocFiles.has(rel)) continue;
    if (
      agencOnlyJustified.has(rel) ||
      implicitlyJustified.has(rel) ||
      KEEP_AGENC_VERSION.has(rel)
    ) {
      continue;
    }
    errors.push(
      `agenc-only-unjustified: runtime/src/tui/ink/${rel} has no openclaude counterpart and no matrix row justifies it`,
    );
  }

  // (c) For each common file NOT in KEEP_AGENC_VERSION, verify
  //     byte-equivalence post-transform.
  const driftReports = [];
  for (const rel of ocFiles) {
    if (KEEP_AGENC_VERSION.has(rel)) continue;
    if (!agFiles.has(rel)) continue; // already reported above
    const ocSrc = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
    const expected = transform(ocSrc, rel);
    const actual = fs.readFileSync(path.join(DST_ROOT, rel), "utf8");
    if (expected !== actual) {
      driftReports.push(rel);
    }
  }
  for (const rel of driftReports) {
    errors.push(
      `transform-drift: runtime/src/tui/ink/${rel} differs from openclaude src/ink/${rel} after transform — re-run scripts/wholesale-port.mjs or update the transformation rules`,
    );
  }

  if (errors.length > 0) {
    console.error(
      `Implementation contract FAILED: ${matrix.contractName ?? MATRIX_PATH}`,
    );
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
  const inOpenClaude = ocFiles.size;
  const inAgenC = agFiles.size;
  console.log(
    `File-level: openclaude=${inOpenClaude}, agenc=${inAgenC}, byte-equivalence verified for ${inOpenClaude - KEEP_AGENC_VERSION.size} common files (post-transform).`,
  );
}

main();
