#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const runtimeRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(runtimeRoot, "..");
const manifestPath = path.join(
  repoRoot,
  "docs/plan/runtime-owner-manifest.md",
);
const runtimeSourceRoot = path.join(runtimeRoot, "src");
const SOURCE_FILE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.test\.(?:ts|tsx|mts|cts)$/;
const ENTRYPOINT_OWNER_KINDS = new Set([
  "live_entrypoint",
  "bootstrap_owner",
  "ui_entrypoint",
]);
const RISKY_FABRICATION_HEURISTICS = new Set([
  "build_turn_context_call",
  "tool_use_context_object_literal",
  "create_subagent_context_call",
  "declares_create_subagent_context",
]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function die(message) {
  process.stderr.write(`[check:runtime-ownership] FAIL: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`[check:runtime-ownership] ${message}\n`);
}

function unique(values) {
  return [...new Set(values)];
}

function pathMatchesPattern(filePath, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === pattern;
}

function isRepoFile(filePath) {
  return filePath.startsWith("runtime/src/");
}

function formatList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function isDirectToolUseContextType(typeNode) {
  if (!typeNode) {
    return false;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName.getText();
    return (
      typeName === "ToolUseContext" || typeName.endsWith(".ToolUseContext")
    );
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isDirectToolUseContextType(typeNode.type);
  }

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((child) => isDirectToolUseContextType(child));
  }

  return false;
}

function normalizeResolvedPath(absPath) {
  const repoRelative = toPosixPath(path.relative(repoRoot, absPath));
  if (!repoRelative || repoRelative.startsWith("../")) {
    return null;
  }
  return repoRelative;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(abs)));
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_FILE_RE.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name)
    ) {
      results.push(abs);
    }
  }
  return results;
}

async function loadManifest() {
  const markdown = await readFile(manifestPath, "utf8");
  const match = markdown.match(
    /<!-- runtime-owner-manifest:json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- runtime-owner-manifest:json:end -->/,
  );
  if (!match) {
    die(
      `could not find machine-readable JSON block in ${toPosixPath(path.relative(repoRoot, manifestPath))}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    die(`manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const requiredKeys = [
    "schemaVersion",
    "trueLocalRuntimeOwners",
    "compatibilityOnlySurfaces",
    "fabricatedContextSeams",
    "legacyRuntimeOwnerFiles",
    "allowedNonRuntimeConsumers",
    "ownershipRules",
    "staticVsSmokeCheckLimits",
    "checkConfig",
  ];
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      die(`manifest JSON is missing required key "${key}"`);
    }
  }
  return parsed;
}

async function loadCompilerOptions() {
  const tsconfigPath = path.join(runtimeRoot, "tsconfig.json");
  const configText = await readFile(tsconfigPath, "utf8");
  const configJson = ts.parseConfigFileTextToJson(tsconfigPath, configText);
  if (configJson.error) {
    die(`failed to parse runtime/tsconfig.json: ${configJson.error.messageText}`);
  }
  const parsedConfig = ts.parseJsonConfigFileContent(
    configJson.config,
    ts.sys,
    runtimeRoot,
  );
  if (parsedConfig.errors.length > 0) {
    die(
      `failed to load runtime/tsconfig.json compiler options:\n${formatList(parsedConfig.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")))}`,
    );
  }
  return parsedConfig.options;
}

function buildImportResolver(compilerOptions) {
  const host = ts.createCompilerHost(compilerOptions, true);
  return (specifier, containingFile) => {
    const resolution = ts.resolveModuleName(
      specifier,
      containingFile,
      compilerOptions,
      host,
    );
    const resolved = resolution.resolvedModule?.resolvedFileName;
    if (!resolved) {
      return null;
    }
    const normalized = normalizeResolvedPath(path.resolve(resolved));
    return normalized && isRepoFile(normalized) ? normalized : null;
  };
}

function analyzeFile(sourceFile, resolveImport) {
  const imports = new Set();
  const heuristics = new Set();

  const registerImport = (node, specifier) => {
    const resolved = resolveImport(specifier, sourceFile.fileName);
    if (!resolved) {
      return;
    }
    imports.add(resolved);

    if (resolved === "runtime/src/query.ts") {
      heuristics.add("imports_query_owner");
    }
    if (pathMatchesPattern(resolved, "runtime/src/services/compact/**")) {
      heuristics.add("imports_legacy_compact_service");
    }
    if (pathMatchesPattern(resolved, "runtime/src/tools/AgentTool/**")) {
      heuristics.add("imports_legacy_agent_tool");
    }
    if (resolved === "runtime/src/session/turn-context.ts") {
      heuristics.add("imports_turn_context_owner");
    }
    if (resolved === "runtime/src/Tool.ts" || resolved === "runtime/src/Tool.tsx") {
      heuristics.add("imports_tool_use_context");
    }
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      registerImport(node, node.moduleSpecifier.text);
      const bindings = node.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((element) => element.name.text === "ToolUseContext")
      ) {
        heuristics.add("imports_tool_use_context");
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      registerImport(node, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "buildTurnContext"
      ) {
        heuristics.add("build_turn_context_call");
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createSubagentContext"
      ) {
        heuristics.add("create_subagent_context_call");
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        registerImport(node, node.arguments[0].text);
      }
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        registerImport(node, node.arguments[0].text);
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer) &&
      isDirectToolUseContextType(node.type)
    ) {
      heuristics.add("tool_use_context_object_literal");
    } else if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      ts.isObjectLiteralExpression(node.expression) &&
      isDirectToolUseContextType(node.type)
    ) {
      heuristics.add("tool_use_context_object_literal");
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "createSubagentContext"
    ) {
      heuristics.add("declares_create_subagent_context");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    imports: unique([...imports]).sort(),
    heuristics: unique([...heuristics]).sort(),
  };
}

function makeLookup(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return map;
}

function getDirectImportException(manifest, importer, target) {
  return manifest.checkConfig.directImportExceptions.find(
    (entry) => entry.importer === importer && entry.target === target,
  );
}

function getOwnerHeuristicEntries(manifest) {
  return manifest.trueLocalRuntimeOwners
    .filter(
      (owner) =>
        !owner.path.endsWith("/**") &&
        Array.isArray(owner.expectedHeuristics) &&
        owner.expectedHeuristics.length > 0,
    )
    .map((owner) => ({
      path: owner.path,
      expectedHeuristics: owner.expectedHeuristics,
      label: `owner ${owner.id}`,
    }));
}

function getDeclaredLiveEntrypoints(manifest) {
  return manifest.trueLocalRuntimeOwners
    .filter(
      (owner) =>
        !owner.path.endsWith("/**") && ENTRYPOINT_OWNER_KINDS.has(owner.kind),
    )
    .map((owner) => owner.path);
}

function findUnexpectedHelperImporters(target, allowedImporters, reverseImports) {
  const currentImporters = reverseImports.get(target) ?? [];
  return currentImporters.filter((importer) => !allowedImporters.includes(importer));
}

function findNewFabricationSites(sourceAnalysis, allowlistedSeams) {
  const scanRoots = [
    "runtime/src/bin/",
    "runtime/src/commands/",
    "runtime/src/utils/",
    "runtime/src/services/",
    "runtime/src/tools/",
  ];

  return sourceAnalysis
    .filter(({ filePath, heuristics }) => {
      if (allowlistedSeams.includes(filePath)) {
        return false;
      }
      if (!scanRoots.some((root) => filePath.startsWith(root))) {
        return false;
      }
      return heuristics.some((heuristic) =>
        RISKY_FABRICATION_HEURISTICS.has(heuristic),
      );
    })
    .map(({ filePath, heuristics }) => ({
      filePath,
      heuristics: heuristics.filter((heuristic) =>
        RISKY_FABRICATION_HEURISTICS.has(heuristic),
      ),
    }));
}

const tsModule = await import("typescript");
const ts = tsModule.default ?? tsModule;

const start = Date.now();
const manifest = await loadManifest();
const compilerOptions = await loadCompilerOptions();
const resolveImport = buildImportResolver(compilerOptions);

const runtimeFiles = (await walk(runtimeSourceRoot))
  .map((absPath) => ({
    absPath,
    filePath: toPosixPath(path.relative(repoRoot, absPath)),
  }))
  .sort((a, b) => a.filePath.localeCompare(b.filePath));

const sourceAnalysis = [];
for (const entry of runtimeFiles) {
  const text = await readFile(entry.absPath, "utf8");
  const sourceFile = ts.createSourceFile(
    entry.absPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    entry.absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceAnalysis.push({
    filePath: entry.filePath,
    ...analyzeFile(sourceFile, resolveImport),
  });
}

const analysisByFile = makeLookup(sourceAnalysis, (entry) => entry.filePath);
const ownerHeuristicEntries = getOwnerHeuristicEntries(manifest);
const declaredLiveEntrypoints = unique(getDeclaredLiveEntrypoints(manifest)).sort();
const reverseImports = new Map();
for (const { filePath, imports } of sourceAnalysis) {
  for (const imported of imports) {
    const importers = reverseImports.get(imported) ?? [];
    importers.push(filePath);
    reverseImports.set(imported, importers);
  }
}
for (const [target, importers] of reverseImports.entries()) {
  reverseImports.set(target, unique(importers).sort());
}

const manifestExactPaths = [];
for (const owner of manifest.trueLocalRuntimeOwners) {
  if (!owner.path.endsWith("/**")) {
    manifestExactPaths.push(owner.path);
  }
  if (Array.isArray(owner.expectedHeuristics) && owner.expectedHeuristics.length > 0) {
    manifestExactPaths.push(owner.path);
  }
}
for (const surface of manifest.compatibilityOnlySurfaces) {
  manifestExactPaths.push(surface.path);
}
for (const seam of manifest.fabricatedContextSeams) {
  if (!seam.path.endsWith("/**")) {
    manifestExactPaths.push(seam.path);
  }
}
for (const legacy of manifest.legacyRuntimeOwnerFiles) {
  if (!legacy.path.endsWith("/**")) {
    manifestExactPaths.push(legacy.path);
  }
}
for (const helper of manifest.allowedNonRuntimeConsumers) {
  manifestExactPaths.push(helper.target);
  manifestExactPaths.push(...helper.allowedImporters);
}
for (const entrypoint of manifest.checkConfig.liveEntrypoints) {
  manifestExactPaths.push(entrypoint);
}
for (const seam of manifest.checkConfig.allowlistedFabricationSeams) {
  manifestExactPaths.push(seam);
}
for (const policy of manifest.checkConfig.helperImportPolicies) {
  manifestExactPaths.push(policy.target);
  manifestExactPaths.push(...policy.allowedImporters);
}
for (const exception of manifest.checkConfig.directImportExceptions) {
  manifestExactPaths.push(exception.importer, exception.target);
}

const missingManifestPaths = unique(manifestExactPaths)
  .filter(Boolean)
  .filter((filePath) => !analysisByFile.has(filePath) && !filePath.startsWith("docs/"));
if (missingManifestPaths.length > 0) {
  die(
    `manifest references files that are not present in runtime/src:\n${formatList(missingManifestPaths)}`,
  );
}

const errors = [];
const warnings = [];

const missingConfiguredLiveEntrypoints = declaredLiveEntrypoints.filter(
  (entrypoint) => !manifest.checkConfig.liveEntrypoints.includes(entrypoint),
);
if (missingConfiguredLiveEntrypoints.length > 0) {
  errors.push(
    `checkConfig.liveEntrypoints is missing declared live owners:\n${formatList(
      missingConfiguredLiveEntrypoints,
    )}`,
  );
}

const undocumentedConfiguredLiveEntrypoints = manifest.checkConfig.liveEntrypoints.filter(
  (entrypoint) => !declaredLiveEntrypoints.includes(entrypoint),
);
if (undocumentedConfiguredLiveEntrypoints.length > 0) {
  errors.push(
    `checkConfig.liveEntrypoints includes paths not declared in trueLocalRuntimeOwners:\n${formatList(
      undocumentedConfiguredLiveEntrypoints,
    )}`,
  );
}

for (const entrypoint of manifest.checkConfig.liveEntrypoints) {
  const analysis = analysisByFile.get(entrypoint);
  if (!analysis) {
    errors.push(`live entrypoint missing from analysis: ${entrypoint}`);
    continue;
  }

  for (const imported of analysis.imports) {
    const matchedRule = manifest.checkConfig.forbiddenDirectImports.find((rule) =>
      pathMatchesPattern(imported, rule.pattern),
    );
    if (!matchedRule) {
      continue;
    }

    const exception = getDirectImportException(manifest, entrypoint, imported);
    if (exception) {
      warnings.push(
        `${entrypoint} directly imports ${imported} (${exception.reason})`,
      );
      continue;
    }

    errors.push(
      `${entrypoint} directly imports forbidden owner ${imported} (${matchedRule.reason})`,
    );
  }
}

for (const exception of manifest.checkConfig.directImportExceptions) {
  const analysis = analysisByFile.get(exception.importer);
  if (!analysis) {
    errors.push(`direct import exception importer missing from analysis: ${exception.importer}`);
    continue;
  }
  if (!manifest.checkConfig.liveEntrypoints.includes(exception.importer)) {
    errors.push(
      `direct import exception importer is not a declared live entrypoint: ${exception.importer}`,
    );
  }
  if (!analysis.imports.includes(exception.target)) {
    errors.push(
      `direct import exception is stale: ${exception.importer} no longer imports ${exception.target}`,
    );
  }
}

for (const owner of ownerHeuristicEntries) {
  const analysis = analysisByFile.get(owner.path);
  if (!analysis) {
    errors.push(`${owner.label} missing from analysis: ${owner.path}`);
    continue;
  }

  const missingHeuristics = owner.expectedHeuristics.filter(
    (heuristic) => !analysis.heuristics.includes(heuristic),
  );
  if (missingHeuristics.length > 0) {
    errors.push(
      `${owner.path} no longer matches ${owner.label} heuristics: ${missingHeuristics.join(", ")}`,
    );
  }
}

for (const seam of manifest.fabricatedContextSeams) {
  const analysis = analysisByFile.get(seam.path);
  if (!analysis) {
    errors.push(`fabricated-context seam missing from analysis: ${seam.path}`);
    continue;
  }

  const missingHeuristics = seam.expectedHeuristics.filter(
    (heuristic) => !analysis.heuristics.includes(heuristic),
  );
  if (missingHeuristics.length > 0) {
    errors.push(
      `${seam.path} no longer matches manifest seam heuristics: ${missingHeuristics.join(", ")}`,
    );
  }
}

for (const seamPath of manifest.checkConfig.allowlistedFabricationSeams) {
  const analysis = analysisByFile.get(seamPath);
  if (!analysis) {
    errors.push(`allowlisted fabrication seam missing from analysis: ${seamPath}`);
    continue;
  }

  const riskyHeuristics = analysis.heuristics.filter((heuristic) =>
    RISKY_FABRICATION_HEURISTICS.has(heuristic),
  );
  if (riskyHeuristics.length === 0) {
    errors.push(
      `allowlisted fabrication seam is stale: ${seamPath} no longer matches risky heuristics`,
    );
  }
}

for (const policy of manifest.checkConfig.helperImportPolicies) {
  const unexpectedImporters = findUnexpectedHelperImporters(
    policy.target,
    policy.allowedImporters,
    reverseImports,
  );
  if (unexpectedImporters.length > 0) {
    errors.push(
      `${policy.target} has unexpected importers:\n${formatList(unexpectedImporters)}`,
    );
  }
}

const allowedNonRuntimeMap = makeLookup(
  manifest.allowedNonRuntimeConsumers,
  (entry) => entry.target,
);
for (const policy of manifest.checkConfig.helperImportPolicies) {
  const helperDoc = allowedNonRuntimeMap.get(policy.target);
  if (!helperDoc) {
    continue;
  }
  const nonRuntimeAllowed = helperDoc.allowedImporters;
  const policyNonRuntime = policy.allowedImporters.filter(
    (importer) =>
      !pathMatchesPattern(importer, "runtime/src/services/compact/**") &&
      !pathMatchesPattern(importer, "runtime/src/llm/compact/**"),
  );
  const missingDocs = policyNonRuntime.filter(
    (importer) => !nonRuntimeAllowed.includes(importer),
  );
  if (missingDocs.length > 0) {
    errors.push(
      `${policy.target} has non-runtime importers missing from allowedNonRuntimeConsumers:\n${formatList(missingDocs)}`,
    );
  }
}

const ownerFabricationAllowlist = ownerHeuristicEntries
  .filter(({ expectedHeuristics }) =>
    expectedHeuristics.some((heuristic) =>
      RISKY_FABRICATION_HEURISTICS.has(heuristic),
    ),
  )
  .map(({ path }) => path);
const newFabricationSites = findNewFabricationSites(
  sourceAnalysis,
  unique([
    ...manifest.checkConfig.allowlistedFabricationSeams,
    ...ownerFabricationAllowlist,
  ]),
);
if (newFabricationSites.length > 0) {
  errors.push(
    `new context-fabrication sites were found outside the manifest allowlist:\n${formatList(
      newFabricationSites.map(
        ({ filePath, heuristics }) =>
          `${filePath} (${heuristics.join(", ")})`,
      ),
    )}`,
  );
}

if (warnings.length > 0) {
  for (const warning of warnings) {
    log(`WARN: ${warning}`);
  }
}

if (errors.length > 0) {
  die(errors.join("\n"));
}

log(`manifest schema v${manifest.schemaVersion} loaded from docs/plan/runtime-owner-manifest.md`);
log(`checked ${sourceAnalysis.length} runtime source files`);
log(
  `validated ${manifest.checkConfig.liveEntrypoints.length} live entrypoints, ` +
    `${ownerHeuristicEntries.length} owner-owned context sites, ` +
    `${manifest.fabricatedContextSeams.length} fabricated-context seams, and ` +
    `${manifest.checkConfig.helperImportPolicies.length} helper import policies`,
);
log(
  `OK (${Date.now() - start}ms). Static structure is clean under the manifest; smoke tests remain the primary proof.`,
);
