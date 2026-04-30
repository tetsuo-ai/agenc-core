#!/usr/bin/env node
/**
 * Implementation contract gate for openclaude-tui-renderer-parity.
 *
 * Same contract shape as ~/.codex/skills/implementation-contract but
 * uses contextual forbidden-language patterns ("placeholder implementation",
 * "TODO parity", etc.) so legitimate technical English ("deferred update",
 * "placeholder row", "partial input") inside renderer comments doesn't
 * false-flag. Pattern matches the project's existing
 * scripts/check-openclaude-tui-core-parity.mjs gate.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const matrixPath = path.resolve(import.meta.dirname, "../parity/openclaude-tui-renderer-parity.json");

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
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON at ${filePath}: ${error.message}`);
  }
}

function resolveFrom(root, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validateRow(row, index, roots) {
  const errors = [];
  const label = isObject(row) && row.id ? row.id : `row[${index}]`;
  if (!isObject(row)) return [`${label}: row must be an object`];

  for (const field of ["id", "source", "target", "status"]) {
    if (typeof row[field] !== "string" || row[field].trim() === "") {
      errors.push(`${label}: '${field}' must be a non-empty string`);
    }
  }
  if (row.status !== "required") {
    errors.push(`${label}: status must be 'required'`);
  }
  if (!Array.isArray(row.requiredBehaviors) || row.requiredBehaviors.length === 0) {
    errors.push(`${label}: requiredBehaviors must be a non-empty array`);
  } else {
    row.requiredBehaviors.forEach((behavior, behaviorIndex) => {
      if (typeof behavior !== "string" || behavior.trim() === "") {
        errors.push(`${label}: requiredBehaviors[${behaviorIndex}] must be a non-empty string`);
        return;
      }
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(behavior)) {
          errors.push(`${label}: requiredBehaviors[${behaviorIndex}] contains shortcut language: ${behavior}`);
          break;
        }
      }
    });
  }
  if (!Array.isArray(row.tests) || row.tests.length === 0) {
    errors.push(`${label}: tests must be a non-empty array`);
  }
  const sourcePath = resolveFrom(roots.sourceRoot, row.source);
  const targetPath = resolveFrom(roots.targetRoot, row.target);
  if (sourcePath && !fs.existsSync(sourcePath)) {
    errors.push(`${label}: source file missing: ${sourcePath}`);
  }
  if (targetPath && !fs.existsSync(targetPath)) {
    errors.push(`${label}: target file missing: ${targetPath}`);
  }
  const scanPaths = [];
  if (targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
    scanPaths.push(targetPath);
  }
  if (Array.isArray(row.tests)) {
    for (const testPath of row.tests) {
      const absoluteTestPath = resolveFrom(roots.targetRoot, testPath);
      if (!absoluteTestPath || !fs.existsSync(absoluteTestPath)) {
        errors.push(`${label}: test file missing: ${absoluteTestPath ?? testPath}`);
      } else if (fs.statSync(absoluteTestPath).isFile()) {
        scanPaths.push(absoluteTestPath);
      }
    }
  }
  for (const scanPath of scanPaths) {
    for (const match of scanForbiddenTerms(scanPath)) {
      errors.push(`${label}: forbidden shortcut language found: ${match}`);
    }
  }
  return errors;
}

function main() {
  const matrix = readJson(matrixPath);
  const errors = [];
  for (const field of ["contractName", "scope", "sourceRoot", "targetRoot"]) {
    if (typeof matrix[field] !== "string" || matrix[field].trim() === "") {
      errors.push(`top-level field '${field}' must be a non-empty string`);
    }
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
    errors.push("top-level 'rows' must be a non-empty array");
  }
  const matrixDir = path.dirname(matrixPath);
  const roots = {
    sourceRoot: resolveFrom(matrixDir, matrix.sourceRoot),
    targetRoot: resolveFrom(matrixDir, matrix.targetRoot),
  };
  if (roots.sourceRoot && !fs.existsSync(roots.sourceRoot)) {
    errors.push(`sourceRoot missing: ${roots.sourceRoot}`);
  }
  if (roots.targetRoot && !fs.existsSync(roots.targetRoot)) {
    errors.push(`targetRoot missing: ${roots.targetRoot}`);
  }
  if (Array.isArray(matrix.rows)) {
    matrix.rows.forEach((row, index) => {
      errors.push(...validateRow(row, index, roots));
    });
  }
  if (errors.length > 0) {
    console.error(`Implementation contract FAILED: ${matrix.contractName ?? matrixPath}`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
}

main();
