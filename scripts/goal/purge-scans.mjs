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

export function disallowedZPurgecTypecheckExcludes(tsconfigSource) {
  const excludes = extractRuntimeTsconfigExcludes(tsconfigSource);
  return excludes.filter((spec) =>
    /^src\/(?:agents|auth|bootstrap|bridge|cli|commands|config|coordinator|cost|elicitation|entrypoints|errors|grpc|llm|migrations|native-ts|outputStyles|plugins|proto|query|relay-proxy|remote|schemas|screens|server|services|session|skills|state|tasks|tools)\/\*\*\/\*$/.test(spec)
  );
}
