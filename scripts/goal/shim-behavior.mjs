export const SHIM_BEHAVIOR_RATIO_LIMIT = 0.5;
export const SHIM_BEHAVIOR_SIGNIFICANT_LINE_LIMIT = 40;
export const SHIM_BEHAVIOR_BODY_LENGTH_LIMIT = 16000;

export const FORWARD_LINE_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*type\s*\{[^}]*\}\s*from\b|export\s*type\s*\{[^}]*\}\s*;?\s*$|export\s*\{[^}]*\}\s*from\b|export\s*\{[^}]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
export const FORWARD_STATEMENT_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*type\s*\{[\s\S]*\}\s*from\b|export\s*type\s*\{[\s\S]*\}\s*;?\s*$|export\s*\{[\s\S]*\}\s*from\b|export\s*\{[\s\S]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
export const SINGLE_LINE_FORWARD_FN_RE =
  /^\s*(?:(?:export\s+default\s+)|(?:export\s+))?(?:async\s+)?function\s+\w*\s*\([\s\S]*\)\s*(?::[^{]+)?\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}\s*$/;
export const SINGLE_LINE_FORWARD_ARROW_RE =
  /^\s*(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?:\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}|[\w$.]+\([^{};]*\)|[\w$.]+\.[\w$]+(?:\([^{};]*\))?)\s*;?\s*$/;

export function significantSourceLines(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .flatMap(splitPackedSourceLine)
    .filter((line) =>
      line &&
      !line.startsWith("//") &&
      !line.startsWith("*") &&
      !line.startsWith("/*") &&
      line !== "*/",
    );
}

function splitPackedSourceLine(line) {
  if (!/\b(?:import|export)\b/.test(line)) return [line];
  return line
    .split(/;\s+(?=(?:import|export)\b)/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function splitImportAndImplementationLines(significant) {
  const implementationLines = [];
  let importLines = 0;
  let inImportBlock = false;

  for (const line of significant) {
    if (inImportBlock) {
      importLines += 1;
      if (/\bfrom\s*["']|;\s*$/.test(line)) {
        inImportBlock = false;
      }
      continue;
    }

    if (/^import\b/.test(line)) {
      importLines += 1;
      if (!(/^import\s*["']/.test(line) || /\bfrom\s*["']|;\s*$/.test(line))) {
        inImportBlock = true;
      }
      continue;
    }

    implementationLines.push(line);
  }

  return { importLines, implementationLines };
}

export function countForwardingLines(significant) {
  let forwardLines = 0;
  for (const stmt of combineLogicalStatements(significant)) {
    if (
      FORWARD_LINE_RE.test(stmt) ||
      FORWARD_STATEMENT_RE.test(stmt) ||
      SINGLE_LINE_FORWARD_FN_RE.test(stmt) ||
      SINGLE_LINE_FORWARD_ARROW_RE.test(stmt)
    ) {
      forwardLines += significantStatementLineCount(stmt);
    }
  }
  return forwardLines;
}

export function combineLogicalStatements(significant) {
  const statements = [];
  let current = "";
  let braceDepth = 0;
  for (const line of significant) {
    const startsMultilineForward = current.length > 0 || /^\s*(?:import|export(?:\s+type)?)\s*\{/u.test(line);
    if (!startsMultilineForward) {
      statements.push(line);
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
    braceDepth += countChar(line, "{") - countChar(line, "}");
    if (
      braceDepth <= 0 &&
      (/(?:;|\bfrom\s+["'][^"']+["'];?)\s*$/u.test(line) ||
        /^export\s+\{[\s\S]*\}\s*;?\s*$/.test(current))
    ) {
      statements.push(current);
      current = "";
      braceDepth = 0;
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

export function measureShimBehavior(body, opts = {}) {
  const bodyLengthLimit = opts.bodyLengthLimit ?? SHIM_BEHAVIOR_BODY_LENGTH_LIMIT;
  const significantLineLimit = opts.significantLineLimit ?? SHIM_BEHAVIOR_SIGNIFICANT_LINE_LIMIT;
  const ratioLimit = opts.ratioLimit ?? SHIM_BEHAVIOR_RATIO_LIMIT;

  const significant = significantSourceLines(body);
  const base = {
    eligible: false,
    violates: false,
    significantLines: significant.length,
    importLines: 0,
    forwardLines: 0,
    ratio: 0,
  };

  if (body.length > bodyLengthLimit) return { ...base, reason: "large-body" };
  if (significant.length === 0) return { ...base, reason: "empty" };
  if (significant.length >= significantLineLimit) return { ...base, reason: "large-module" };

  const { importLines, implementationLines } = splitImportAndImplementationLines(significant);
  const forwardLines = countForwardingLines(implementationLines);
  const numerator = importLines + forwardLines;
  const ratio = numerator / significant.length;

  return {
    eligible: implementationLines.length > 0,
    violates:
      implementationLines.length > 0 &&
      forwardLines > 0 &&
      numerator > 0 &&
      ratio > ratioLimit,
    significantLines: significant.length,
    importLines,
    forwardLines,
    ratio,
  };
}

export function measureShimBehaviorForPath(rel, body, opts = {}) {
  const stats = measureShimBehavior(body, opts);
  if (!stats.violates) return null;
  return { path: rel, ...stats };
}

export function formatShimBehaviorViolation(violation) {
  return (
    `${violation.path} (` +
    `${violation.importLines} import line(s) + ` +
    `${violation.forwardLines} forward LOC / ` +
    `${violation.significantLines} significant line(s), ` +
    `ratio ${violation.ratio.toFixed(2)})`
  );
}

function countChar(value, needle) {
  let count = 0;
  for (const char of value) {
    if (char === needle) count += 1;
  }
  return count;
}

function significantStatementLineCount(statement) {
  return statement
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}
