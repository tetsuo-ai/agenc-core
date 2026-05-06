import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runtimeSrc = resolve(root, "runtime/src");
const promptSuggestionService = resolve(runtimeSrc, "services/PromptSuggestion");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return listSourceFiles(full);
    return /\.(ts|tsx)$/.test(full) ? [full] : [];
  });
}

function importSpecs(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

function resolveImport(importer: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("src/")) return null;
  const base = spec.startsWith("src/") ? resolve(root, "runtime", spec) : resolve(dirname(importer), spec);
  const withoutRuntimeExtension = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    withoutRuntimeExtension,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    join(withoutRuntimeExtension, "index.ts"),
    join(withoutRuntimeExtension, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolvedImportsFor(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return importSpecs(source).flatMap((spec) => {
    const resolved = resolveImport(file, spec);
    return resolved ? [resolved] : [];
  });
}

describe("prompt suggestion service ownership", () => {
  it("keeps production PromptSuggestion imports on owned service files", () => {
    const productionFiles = listSourceFiles(runtimeSrc).filter((file) => {
      if (file.includes(".test.")) return false;
      return true;
    });

    const offenders = productionFiles.flatMap((file) =>
      importSpecs(readFileSync(file, "utf8"))
        .filter((spec) => spec.includes("PromptSuggestion"))
        .filter((spec) => {
          const resolved = resolveImport(file, spec);
          return !resolved || relative(promptSuggestionService, resolved).startsWith("..");
        })
        .map((spec) => ({
          file: relative(root, file),
          importPath: spec,
        })),
    );

    expect(offenders).toEqual([]);
  });

  it("resolves known live callers to AgenC-owned PromptSuggestion files", () => {
    expect(existsSync(promptSuggestionService)).toBe(true);
    const expected = new Map([
      ["runtime/src/query/stopHooks.ts", "runtime/src/services/PromptSuggestion/promptSuggestion.ts"],
      ["runtime/src/tui/screens/REPL.tsx", "runtime/src/services/PromptSuggestion/speculation.ts"],
      ["runtime/src/tasks/LocalAgentTask/LocalAgentTask.tsx", "runtime/src/services/PromptSuggestion/speculation.ts"],
      ["runtime/src/tasks/LocalShellTask/LocalShellTask.tsx", "runtime/src/services/PromptSuggestion/speculation.ts"],
    ]);

    for (const [caller, target] of expected) {
      expect(resolvedImportsFor(resolve(root, caller)).map((file) => relative(root, file))).toContain(target);
    }
  });
});
