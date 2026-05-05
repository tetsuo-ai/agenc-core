export const SHIM_BEHAVIOR_RATIO_LIMIT = 0.5;
export const SHIM_BEHAVIOR_SIGNIFICANT_LINE_LIMIT = 40;

export const FORWARD_LINE_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*type\s*\{[^}]*\}\s*from\b|export\s*type\s*\{[^}]*\}\s*;?\s*$|export\s*\{[^}]*\}\s*from\b|export\s*\{[^}]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
export const FORWARD_STATEMENT_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*type\s*\{[\s\S]*\}\s*from\b|export\s*type\s*\{[\s\S]*\}\s*;?\s*$|export\s*\{[\s\S]*\}\s*from\b|export\s*\{[\s\S]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
export const SINGLE_LINE_FORWARD_FN_RE =
  /^\s*(?:(?:export\s+default\s+)|(?:export\s+))?(?:async\s+)?function\s+\w*\s*\([\s\S]*\)\s*(?::[^{]+)?\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}\s*$/;
export const FORWARD_FN_WITH_LOCAL_ALIASES_RE =
  /^\s*(?:(?:export\s+default\s+)|(?:export\s+))?(?:async\s+)?function\s+([\w$]*)\s*\([\s\S]*?\)\s*(?::[^{]+)?\{([\s\S]*)\}\s*$/;
export const SINGLE_LINE_FORWARD_ARROW_RE =
  /^\s*(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?:\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}|[\w$.]+\([^{};]*\)|[\w$.]+\.[\w$]+(?:\([^{};]*\))?)\s*;?\s*$/;
export const EXPORTED_TYPE_ALIAS_RE =
  /^\s*export\s+type\s+\w+(?:\s*<[\s\S]*?>)?\s*=\s*([\w$]+)(?:\s*<[\s\S]*>)?\s*;?\s*$/;
export const EXPORTED_VALUE_ALIAS_RE =
  /^\s*export\s+const\s+\w+\s*(?::[^=]+)?=\s*([\w$]+)\s*;?\s*$/;
export const COMMONJS_REQUIRE_RE =
  /^\s*(?:const|let|var)\s+([\w$]+)\s*=\s*require\s*\(\s*["'][^"']+["']\s*\)\s*;?\s*$/;
export const COMMONJS_DESTRUCTURED_REQUIRE_RE =
  /^\s*(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*require\s*\(\s*["'][^"']+["']\s*\)\s*;?\s*$/;
export const COMMONJS_MODULE_EXPORT_RE =
  /^\s*module\.exports\s*=\s*([\w$]+)\s*;?\s*$/;
export const COMMONJS_NAMED_EXPORT_RE =
  /^\s*(?:module\.)?exports\.[\w$]+\s*=\s*([\w$]+)(?:\.[\w$]+)?\s*;?\s*$/;

export function significantSourceLines(body) {
  return stripComments(body)
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
  const importedBindings = new Set();
  let importLines = 0;
  let inImportBlock = false;
  let currentImportStatement = "";

  for (const line of significant) {
    if (inImportBlock) {
      importLines += 1;
      currentImportStatement = `${currentImportStatement}\n${line}`;
      if (/\bfrom\s*["']|;\s*$/.test(line)) {
        addImportedBindings(currentImportStatement, importedBindings);
        inImportBlock = false;
        currentImportStatement = "";
      }
      continue;
    }

    if (/^import\b/.test(line)) {
      importLines += 1;
      currentImportStatement = line;
      if (!(/^import\s*["']/.test(line) || /\bfrom\s*["']|;\s*$/.test(line))) {
        inImportBlock = true;
      } else {
        addImportedBindings(currentImportStatement, importedBindings);
        currentImportStatement = "";
      }
      continue;
    }

    if (isCommonJSRequireLine(line)) {
      importLines += 1;
      addCommonJSRequireBindings(line, importedBindings);
      continue;
    }

    implementationLines.push(line);
  }

  return { importLines, implementationLines, importedBindings };
}

export function countForwardingLines(significant, importedBindings = new Set()) {
  let forwardLines = 0;
  for (const stmt of combineLogicalStatements(significant)) {
    if (
      FORWARD_LINE_RE.test(stmt) ||
      FORWARD_STATEMENT_RE.test(stmt) ||
      (!stmt.includes("\n") && SINGLE_LINE_FORWARD_FN_RE.test(stmt)) ||
      isForwardingFunctionStatement(stmt, importedBindings) ||
      SINGLE_LINE_FORWARD_ARROW_RE.test(stmt) ||
      isImportedAliasForward(stmt, importedBindings) ||
      isCommonJSExportForward(stmt, importedBindings)
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
    const startsMultilineForward =
      current.length > 0 ||
      /^\s*(?:import|export(?:\s+type)?)\s*\{/u.test(line) ||
      /^\s*(?:(?:export\s+default\s+)|(?:export\s+))?(?:async\s+)?function\b/u.test(line) ||
      (/^\s*(?:export\s+)?const\s+\w+[\s\S]*=>/u.test(line) && line.includes("{"));
    if (!startsMultilineForward) {
      statements.push(line);
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
    braceDepth += countChar(line, "{") - countChar(line, "}");
    if (
      braceDepth <= 0 &&
      (/(?:;|\bfrom\s+["'][^"']+["'];?)\s*$/u.test(line) ||
        /^export\s+\{[\s\S]*\}\s*;?\s*$/.test(current) ||
        isFunctionOrArrowBlockComplete(current, line))
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

  if (significant.length === 0) return { ...base, reason: "empty" };
  if (significant.length >= significantLineLimit) return { ...base, reason: "large-module" };

  const { importLines, implementationLines, importedBindings } =
    splitImportAndImplementationLines(significant);
  const forwardLines = countForwardingLines(implementationLines, importedBindings);
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

function stripComments(body) {
  let output = "";
  let inBlock = false;
  let inLine = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    const next = body[i + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        output += char;
      }
      continue;
    }

    if (inBlock) {
      if (char === "\n") output += char;
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if ((char === "'" || char === '"' || char === "`") && !quote) {
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function addImportedBindings(statement, importedBindings) {
  const namespaceMatch = statement.match(/\*\s+as\s+([\w$]+)/u);
  if (namespaceMatch) importedBindings.add(namespaceMatch[1]);

  const defaultMatch = statement.match(
    /^import\s+(?!type\b)([\w$]+)\s*(?:,|\s+from\b)/u,
  );
  if (defaultMatch) importedBindings.add(defaultMatch[1]);

  const namedMatch = statement.match(/\{([\s\S]*?)\}/u);
  if (!namedMatch) return;

  for (const item of namedMatch[1].split(",")) {
    const cleaned = item.trim().replace(/^type\s+/u, "");
    if (!cleaned) continue;
    const parts = cleaned.split(/\s+as\s+/u).map((part) => part.trim());
    importedBindings.add(parts.at(-1));
  }
}

function isCommonJSRequireLine(line) {
  return (
    COMMONJS_REQUIRE_RE.test(line) ||
    COMMONJS_DESTRUCTURED_REQUIRE_RE.test(line)
  );
}

function addCommonJSRequireBindings(line, importedBindings) {
  const requireMatch = line.match(COMMONJS_REQUIRE_RE);
  if (requireMatch) {
    importedBindings.add(requireMatch[1]);
    return;
  }

  const destructuredMatch = line.match(COMMONJS_DESTRUCTURED_REQUIRE_RE);
  if (!destructuredMatch) return;
  for (const item of destructuredMatch[1].split(",")) {
    const cleaned = item.trim();
    if (!cleaned) continue;
    const parts = cleaned.split(/\s*:\s*/u).map((part) => part.trim());
    importedBindings.add(parts.at(-1));
  }
}

function isImportedAliasForward(statement, importedBindings) {
  const typeAlias = statement.match(EXPORTED_TYPE_ALIAS_RE);
  if (typeAlias && importedBindings.has(typeAlias[1])) return true;

  const valueAlias = statement.match(EXPORTED_VALUE_ALIAS_RE);
  return Boolean(valueAlias && importedBindings.has(valueAlias[1]));
}

function isCommonJSExportForward(statement, importedBindings) {
  const moduleExport = statement.match(COMMONJS_MODULE_EXPORT_RE);
  if (moduleExport && importedBindings.has(moduleExport[1])) return true;

  const namedExport = statement.match(COMMONJS_NAMED_EXPORT_RE);
  return Boolean(namedExport && importedBindings.has(namedExport[1]));
}

function isForwardingFunctionStatement(statement, importedBindings) {
  const functionMatch = statement.match(FORWARD_FN_WITH_LOCAL_ALIASES_RE);
  if (!functionMatch) return false;

  const functionName = functionMatch[1] ?? "";
  const body = functionMatch[2].trim();
  const localAliases = new Set();
  let sawImportedAliasStatement = false;
  const bodyWithoutAliases = body
    .replace(
      /^\s*const\s+([\w$]+)\s*=\s*([\w$.]+)\s*;?\s*$/gmu,
      (_match, local, source) => {
        const sourceBase = String(source).split(".")[0];
        if (importedBindings.has(sourceBase)) {
          localAliases.add(local);
          sawImportedAliasStatement = true;
        }
        return "";
      },
    )
    .trim();
  const returnMatch = bodyWithoutAliases.match(
    /^(?:return\s+(?:await\s+)?|await\s+)?([\w$]+)(?:\.[\w$]+)?\([^{};]*\)\s*;?$/u,
  );
  if (!returnMatch) return false;

  const calleeBase = returnMatch[1];
  if (localAliases.has(calleeBase)) return true;
  if (!importedBindings.has(calleeBase)) return false;
  if (sawImportedAliasStatement) return true;

  return functionNameWrapsImportedCallee(functionName, calleeBase);
}

function functionNameWrapsImportedCallee(functionName, calleeBase) {
  if (!functionName || !calleeBase) return false;
  if (functionName === calleeBase) return true;
  if (
    calleeBase.endsWith("Impl") &&
    functionName === calleeBase.slice(0, -"Impl".length)
  ) {
    return true;
  }
  if (
    calleeBase.endsWith("Implementation") &&
    functionName === calleeBase.slice(0, -"Implementation".length)
  ) {
    return true;
  }
  return functionName.includes(calleeBase) || calleeBase.includes(functionName);
}

function isFunctionOrArrowBlockComplete(statement, line) {
  return (
    /^\s*(?:(?:(?:export\s+default\s+)|(?:export\s+))?(?:async\s+)?function\b|(?:export\s+)?const\s+\w+[\s\S]*=>)/u.test(
      statement,
    ) && /\}\s*;?\s*$/u.test(line)
  );
}

function significantStatementLineCount(statement) {
  return statement
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}
