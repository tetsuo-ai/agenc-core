import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const RUNTIME_UPSTREAM_SCAN_PATHS = [
  "runtime/src",
  "runtime/tests",
  "runtime/tsconfig*.json",
  "runtime/tsup.config.ts",
  "runtime/package.json",
  "runtime/vitest.config.ts",
];

const STALE_RUNTIME_UPSTREAM_RE =
  /(?:runtime\/src\/agenc\/upstream|src\/agenc\/upstream|agenc\/upstream)/;

export function collectRuntimeUpstreamReferences({ root, files }) {
  const stale = [];
  for (const rel of files) {
    if (rel.startsWith("runtime/src/agenc/upstream/")) continue;
    const abs = path.join(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (STALE_RUNTIME_UPSTREAM_RE.test(line)) {
        stale.push(`${rel}:${index + 1}: ${line.trim().slice(0, 180)}`);
      }
    });
  }
  return stale;
}

export function extractRuntimeTsconfigExcludes(tsconfigSource) {
  const excludeMatch = /"exclude"\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(tsconfigSource);
  if (!excludeMatch) return [];
  return [...excludeMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export const Z_PURGEC_TSCONFIG_BOUNDARY_START =
  "// Z-PURGEC verified temporary baseline boundary start.";
export const Z_PURGEC_TSCONFIG_BOUNDARY_END =
  "// Z-PURGEC verified temporary baseline boundary end.";
export const Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT = 367;

export function extractMarkedZPurgecTsconfigBoundary(tsconfigSource) {
  const startIndex = tsconfigSource.indexOf(Z_PURGEC_TSCONFIG_BOUNDARY_START);
  const endIndex = tsconfigSource.indexOf(Z_PURGEC_TSCONFIG_BOUNDARY_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return [];
  }
  return [...tsconfigSource.slice(startIndex, endIndex).matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
}

export function disallowedZPurgecTypecheckExcludes(tsconfigSource) {
  const excludes = extractRuntimeTsconfigExcludes(tsconfigSource);
  return excludes.filter((spec) =>
    /^src\/(?:agents|auth|bootstrap|bridge|cli|commands|config|coordinator|cost|elicitation|entrypoints|errors|grpc|llm|migrations|native-ts|outputStyles|plugins|proto|query|relay-proxy|remote|schemas|screens|server|services|session|skills|state|tasks|tools)\/\*\*\/\*$/.test(spec)
  );
}

export function validateZPurgecTsconfigBoundary(tsconfigSource) {
  const issues = [];
  const startCount = tsconfigSource.split(Z_PURGEC_TSCONFIG_BOUNDARY_START).length - 1;
  const endCount = tsconfigSource.split(Z_PURGEC_TSCONFIG_BOUNDARY_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    issues.push(
      `expected exactly one Z-PURGEC tsconfig boundary marker pair, found ${startCount} start marker(s) and ${endCount} end marker(s)`,
    );
  }

  const entries = extractMarkedZPurgecTsconfigBoundary(tsconfigSource);
  if (entries.length !== Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT) {
    issues.push(
      `expected ${Z_PURGEC_TSCONFIG_BOUNDARY_ENTRY_COUNT} concrete Z-PURGEC tsconfig boundary entries, found ${entries.length}`,
    );
  }

  const duplicates = [...new Set(entries.filter((entry, index) => entries.indexOf(entry) !== index))];
  if (duplicates.length > 0) {
    issues.push(`duplicate Z-PURGEC tsconfig boundary entries:\n  ${duplicates.join("\n  ")}`);
  }

  const broadExcludes = disallowedZPurgecTypecheckExcludes(tsconfigSource);
  if (broadExcludes.length > 0) {
    issues.push(
      `runtime/tsconfig.json still excludes migrated Z-PURGEC roots from typecheck:\n  ${broadExcludes.join("\n  ")}`,
    );
  }

  return { entries, issues };
}
