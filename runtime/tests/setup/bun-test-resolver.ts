import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeSourceRoot = resolve(runtimeRoot, "src");
const runtimeTestRoot = resolve(runtimeRoot, "tests");

function splitModuleId(id: string): { readonly path: string; readonly suffix: string } {
  const index = id.search(/[?#]/);
  if (index === -1) return { path: id, suffix: "" };
  return {
    path: id.slice(0, index),
    suffix: id.slice(index),
  };
}

function splitModulePath(id: string): { readonly path: string; readonly suffix: string } {
  const moduleId = splitModuleId(id);
  return {
    path: moduleId.path.startsWith("file:")
      ? fileURLToPath(moduleId.path)
      : moduleId.path,
    suffix: moduleId.suffix,
  };
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function existingFile(base: string): string | null {
  const hasExtension = /\.[^/\\]+$/.test(base);
  const candidates = hasExtension
    ? [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        base.replace(/\.jsx$/, ".tsx"),
      ]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
        resolve(base, "index.js"),
      ];

  return candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function remapRuntimeRootTarget(sourceImporter: string, sourcePath: string): string | null {
  const absolute = resolve(dirname(sourceImporter), sourcePath);
  if (!isWithin(runtimeRoot, absolute) || isWithin(runtimeSourceRoot, absolute)) {
    return null;
  }

  const runtimeRelative = relative(runtimeRoot, absolute);
  return existingFile(resolve(runtimeSourceRoot, runtimeRelative));
}

Bun.plugin({
  name: "agenc-moved-test-source-resolver",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      if (!args.importer) return undefined;

      const importer = splitModulePath(args.importer).path;
      if (!isWithin(runtimeTestRoot, importer)) return undefined;

      const source = splitModuleId(args.path);
      const testTarget = existingFile(resolve(dirname(importer), source.path));
      if (testTarget !== null) return undefined;

      const sourceImporter = resolve(
        runtimeSourceRoot,
        relative(runtimeTestRoot, importer),
      );
      const sourceTarget = existingFile(resolve(dirname(sourceImporter), source.path));
      const relocatedTarget =
        sourceTarget ?? remapRuntimeRootTarget(sourceImporter, source.path);
      if (relocatedTarget === null) return undefined;

      return { path: relocatedTarget };
    });
  },
});
