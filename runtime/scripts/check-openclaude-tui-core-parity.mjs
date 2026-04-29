#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(SCRIPT_DIR, "../parity/openclaude-tui-core-matrix.json");
const REQUIRED_TOP_LEVEL_FIELDS = [
  "contractName",
  "scope",
  "sourceRoot",
  "targetRoot",
  "validationCommand",
];
const REQUIRED_ROW_FIELDS = [
  "id",
  "source",
  "target",
  "requiredBehaviors",
  "tests",
  "status",
];
const FORBIDDEN_SHORTCUT_PATTERNS = [
  /TODO parity/i,
  /future search box/i,
  /future follow-?up/i,
  /follow-?up commit/i,
  /reduced renderer/i,
  /implementation placeholder/i,
  /placeholder implementation/i,
  /partial implementation/i,
  /stub implementation/i,
  /not implemented/i,
  /\bnot yet\b/i,
];

function fail(message) {
  return { ok: false, message };
}

function pass(message) {
  return { ok: true, message };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filePath} as JSON: ${error.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveFrom(root, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return null;
  }
  return path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
}

function requireExistingFile(label, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fail(`${label} missing: ${filePath ?? "(empty path)"}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    return fail(`${label} is not a file: ${filePath}`);
  }
  return pass(`${label} exists: ${filePath}`);
}

function scanForbiddenTerms(label, filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const findings = [];
  content.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of FORBIDDEN_SHORTCUT_PATTERNS) {
      if (pattern.test(line)) {
        findings.push(`${label}:${index + 1}: ${line.trim()}`);
        break;
      }
    }
  });
  return findings;
}

function validateStringField(object, field, context) {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    return fail(`${context}.${field} must be a non-empty string`);
  }
  return pass(`${context}.${field}`);
}

function validateBehaviorText(row, context) {
  const results = [];
  if (!Array.isArray(row.requiredBehaviors) || row.requiredBehaviors.length === 0) {
    results.push(fail(`${context}.requiredBehaviors must be a non-empty array`));
    return results;
  }

  row.requiredBehaviors.forEach((behavior, index) => {
    if (typeof behavior !== "string" || behavior.trim() === "") {
      results.push(fail(`${context}.requiredBehaviors[${index}] must be a non-empty string`));
      return;
    }
    for (const pattern of FORBIDDEN_SHORTCUT_PATTERNS) {
      if (pattern.test(behavior)) {
        results.push(fail(`${context}.requiredBehaviors[${index}] contains shortcut language: ${behavior}`));
        return;
      }
    }
    results.push(pass(`${context}.requiredBehaviors[${index}]`));
  });

  return results;
}

function validateTests(row, context, targetRoot) {
  const results = [];
  if (!Array.isArray(row.tests) || row.tests.length === 0) {
    results.push(fail(`${context}.tests must be a non-empty array`));
    return results;
  }

  row.tests.forEach((testPath, index) => {
    if (typeof testPath !== "string" || testPath.trim() === "") {
      results.push(fail(`${context}.tests[${index}] must be a non-empty string`));
      return;
    }
    const absoluteTestPath = resolveFrom(targetRoot, testPath);
    results.push(requireExistingFile(`${context}.tests[${index}]`, absoluteTestPath));
    if (absoluteTestPath && fs.existsSync(absoluteTestPath) && fs.statSync(absoluteTestPath).isFile()) {
      for (const finding of scanForbiddenTerms(`${context}.tests[${index}]`, absoluteTestPath)) {
        results.push(fail(`forbidden shortcut language in ${finding}`));
      }
    }
  });

  return results;
}

function validateRow(row, index, roots) {
  const context = `rows[${index}]${isObject(row) && row.id ? `(${row.id})` : ""}`;
  const results = [];

  if (!isObject(row)) {
    return [fail(`${context} must be an object`)];
  }

  for (const field of REQUIRED_ROW_FIELDS) {
    if (!(field in row)) {
      results.push(fail(`${context}.${field} is required`));
    }
  }

  for (const field of ["id", "source", "target", "status"]) {
    results.push(validateStringField(row, field, context));
  }

  if (row.status !== "required") {
    results.push(fail(`${context}.status must stay 'required' unless the user explicitly changes the contract`));
  }

  const sourcePath = resolveFrom(roots.sourceRoot, row.source);
  const targetPath = resolveFrom(roots.targetRoot, row.target);
  results.push(requireExistingFile(`${context}.source`, sourcePath));
  results.push(requireExistingFile(`${context}.target`, targetPath));

  if (Array.isArray(row.secondaryTargets)) {
    row.secondaryTargets.forEach((secondaryTarget, secondaryIndex) => {
      results.push(requireExistingFile(
        `${context}.secondaryTargets[${secondaryIndex}]`,
        resolveFrom(roots.targetRoot, secondaryTarget),
      ));
    });
  }

  results.push(...validateBehaviorText(row, context));
  results.push(...validateTests(row, context, roots.targetRoot));

  const targetFiles = [targetPath];
  if (Array.isArray(row.secondaryTargets)) {
    row.secondaryTargets.forEach((secondaryTarget) => {
      targetFiles.push(resolveFrom(roots.targetRoot, secondaryTarget));
    });
  }

  targetFiles
    .filter((targetFile) => targetFile && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile())
    .forEach((targetFile) => {
      for (const finding of scanForbiddenTerms(`${context}.target`, targetFile)) {
        results.push(fail(`forbidden shortcut language in ${finding}`));
      }
    });

  return results;
}

function main() {
  const matrix = readJson(CONTRACT_PATH);
  const matrixDir = path.dirname(CONTRACT_PATH);
  const results = [];

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in matrix)) {
      results.push(fail(`matrix.${field} is required`));
      continue;
    }
    results.push(validateStringField(matrix, field, "matrix"));
  }

  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
    results.push(fail("matrix.rows must be a non-empty array"));
  }

  const roots = {
    sourceRoot: resolveFrom(matrixDir, matrix.sourceRoot),
    targetRoot: resolveFrom(matrixDir, matrix.targetRoot),
  };
  results.push(requireExistingDirectory("matrix.sourceRoot", roots.sourceRoot));
  results.push(requireExistingDirectory("matrix.targetRoot", roots.targetRoot));

  if (Array.isArray(matrix.rows)) {
    matrix.rows.forEach((row, index) => {
      results.push(...validateRow(row, index, roots));
    });
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.error(`OpenClaude TUI core parity contract FAILED (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
    failures.forEach((failure) => {
      console.error(`- ${failure.message}`);
    });
    process.exit(1);
  }

  console.log(`OpenClaude TUI core parity contract passed (${matrix.rows.length} required rows)`);
}

function requireExistingDirectory(label, directoryPath) {
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return fail(`${label} missing: ${directoryPath ?? "(empty path)"}`);
  }
  if (!fs.statSync(directoryPath).isDirectory()) {
    return fail(`${label} is not a directory: ${directoryPath}`);
  }
  return pass(`${label} exists: ${directoryPath}`);
}

main();
