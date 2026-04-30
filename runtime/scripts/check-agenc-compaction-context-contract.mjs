#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const matrixPath = path.join(repoRoot, "runtime/parity/agenc-compaction-context.json");

const forbiddenTerms = [
  /TODO parity/i,
  /future follow-?up/i,
  /follow-?up commit/i,
  /source snapshot/i,
  /\bimplementation stub\b/i,
  /\bstubbed implementation\b/i,
  /\bplaceholder (implementation|test|behavior|logic)\b/i,
  /\bpartial (implementation|port|coverage|work)\b/i,
  /\bdeferred (implementation|row|contract|port|test)\b/i
];

const blockedNameTerms = [
  [99, 108, 97, 117, 100, 101],
  [99, 111, 100, 101, 120],
].map((codes) => String.fromCharCode(...codes));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveFrom(root, value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function collectSourceFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(c|m)?[jt]sx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectFiles(targetPath) {
  const files = [];
  if (!fs.existsSync(targetPath)) {
    return files;
  }
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return [targetPath];
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    files.push(...collectFiles(path.join(targetPath, entry.name)));
  }
  return files;
}

function containsBlockedName(value) {
  const normalized = value.toLowerCase();
  return blockedNameTerms.some((term) => normalized.includes(term));
}

function scanForbiddenTerms(filePath) {
  const matches = [];
  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of forbiddenTerms) {
      if (pattern.test(line)) {
        matches.push(`${filePath}:${index + 1}: ${line.trim()}`);
        break;
      }
    }
  });
  return matches;
}

function validateMatrixShape(matrix) {
  const errors = [];
  for (const field of ["contractName", "scope", "sourceRoot", "targetRoot"]) {
    if (typeof matrix[field] !== "string" || matrix[field].trim() === "") {
      errors.push(`top-level field '${field}' must be a non-empty string`);
    }
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
    errors.push("top-level field 'rows' must be a non-empty array");
  }
  if (!Array.isArray(matrix.removalTargets) || matrix.removalTargets.length === 0) {
    errors.push("top-level field 'removalTargets' must be a non-empty array");
  }
  if (!Array.isArray(matrix.forbiddenRuntimePatterns) || matrix.forbiddenRuntimePatterns.length === 0) {
    errors.push("top-level field 'forbiddenRuntimePatterns' must be a non-empty array");
  }
  if (!Array.isArray(matrix.brandingScopes) || matrix.brandingScopes.length === 0) {
    errors.push("top-level field 'brandingScopes' must be a non-empty array");
  }
  return errors;
}

function validateRow(row, index, roots) {
  const errors = [];
  const label = isObject(row) && row.id ? row.id : `row[${index}]`;

  if (!isObject(row)) {
    return [`${label}: row must be an object`];
  }

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
      }
      for (const pattern of forbiddenTerms) {
        if (pattern.test(String(behavior))) {
          errors.push(`${label}: requiredBehaviors[${behaviorIndex}] contains forbidden shortcut language`);
        }
      }
    });
  }

  if (!Array.isArray(row.tests) || row.tests.length === 0) {
    errors.push(`${label}: tests must be a non-empty array`);
  } else {
    row.tests.forEach((testPath, testIndex) => {
      if (typeof testPath !== "string" || testPath.trim() === "") {
        errors.push(`${label}: tests[${testIndex}] must be a non-empty string`);
      }
    });
  }

  const rowSourceRoot = resolveFrom(roots.matrixDir, row.sourceRoot) ?? roots.sourceRoot;
  const sourcePath = resolveFrom(rowSourceRoot, row.source);
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

function validateRemovalTargets(matrix, roots) {
  const errors = [];
  for (const target of matrix.removalTargets ?? []) {
    const targetPath = resolveFrom(roots.targetRoot, target);
    if (!targetPath) {
      errors.push(`removal target is invalid: ${target}`);
    } else if (fs.existsSync(targetPath)) {
      errors.push(`removed AgenC compaction/context target still exists: ${target}`);
    }
  }
  return errors;
}

function validateForbiddenRuntimePatterns(matrix, roots) {
  const errors = [];
  const runtimeSrc = path.join(roots.targetRoot, "runtime/src");
  const agencRoot = path.join(runtimeSrc, "agenc");
  const files = collectSourceFiles(runtimeSrc).filter((filePath) => {
    const relativeToAgenC = path.relative(agencRoot, filePath);
    return relativeToAgenC.startsWith("..") || path.isAbsolute(relativeToAgenC);
  });
  for (const entry of matrix.forbiddenRuntimePatterns ?? []) {
    if (!isObject(entry) || typeof entry.id !== "string" || typeof entry.pattern !== "string") {
      errors.push("forbiddenRuntimePatterns entries must include string id and pattern");
      continue;
    }
    const regex = new RegExp(entry.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf8");
      if (regex.test(content)) {
        errors.push(`${entry.id}: forbidden old AgenC reference '${entry.pattern}' found in ${path.relative(roots.targetRoot, filePath)}`);
      }
    }
  }
  return errors;
}

function validateNamingGate(matrix, roots) {
  const errors = [];
  const scopes = matrix.brandingScopes ?? [];
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.trim() === "") {
      errors.push("brandingScopes entries must be non-empty strings");
      continue;
    }
    const scopePath = resolveFrom(roots.targetRoot, scope);
    if (!scopePath || !fs.existsSync(scopePath)) {
      errors.push(`branding scope missing: ${scope}`);
      continue;
    }
    for (const filePath of collectFiles(scopePath)) {
      const relative = path.relative(roots.targetRoot, filePath);
      if (containsBlockedName(relative)) {
        errors.push(`external brand term found in path: ${relative}`);
      }
      if (!fs.statSync(filePath).isFile()) {
        continue;
      }
      const content = fs.readFileSync(filePath, "utf8");
      if (containsBlockedName(content)) {
        errors.push(`external brand term found in file: ${relative}`);
      }
    }
  }
  return errors;
}

function main() {
  const errors = [];
  let matrix;
  try {
    matrix = readJson(matrixPath);
  } catch (error) {
    console.error(`Implementation contract FAILED: cannot read ${matrixPath}`);
    console.error(error.message);
    process.exit(1);
  }

  errors.push(...validateMatrixShape(matrix));

  const matrixDir = path.dirname(matrixPath);
  const roots = {
    matrixDir,
    sourceRoot: resolveFrom(matrixDir, matrix.sourceRoot),
    targetRoot: resolveFrom(matrixDir, matrix.targetRoot)
  };

  if (!roots.sourceRoot || !fs.existsSync(roots.sourceRoot)) {
    errors.push(`sourceRoot missing: ${roots.sourceRoot ?? matrix.sourceRoot}`);
  }
  if (!roots.targetRoot || !fs.existsSync(roots.targetRoot)) {
    errors.push(`targetRoot missing: ${roots.targetRoot ?? matrix.targetRoot}`);
  }

  if (Array.isArray(matrix.rows)) {
    matrix.rows.forEach((row, index) => {
      errors.push(...validateRow(row, index, roots));
    });
  }
  if (roots.targetRoot) {
    errors.push(...validateRemovalTargets(matrix, roots));
    errors.push(...validateForbiddenRuntimePatterns(matrix, roots));
    errors.push(...validateNamingGate(matrix, roots));
  }

  if (errors.length > 0) {
    console.error(`Implementation contract FAILED: ${matrix.contractName ?? "agenc-compaction-context"}`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
}

main();
