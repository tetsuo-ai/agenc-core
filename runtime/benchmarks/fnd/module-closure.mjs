import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { register } from "tsx/esm/api";

import { MAX_PRODUCTION_MODULES_PER_CASE } from "./contract.mjs";

export const PRODUCTION_MODULE_RECORD_PREFIX =
  "AGENC_FND_BENCH_PRODUCTION_MODULE ";

export function registerProductionModuleTracker(options) {
  const validated = validateOptions(options);
  const observedPaths = new Set();
  const unregister = register({
    onImport(url) {
      const path = productionModulePath(url, validated);
      if (path === undefined || observedPaths.has(path)) return;
      if (observedPaths.size >= MAX_PRODUCTION_MODULES_PER_CASE) {
        throw new Error(
          `production module closure exceeds ${MAX_PRODUCTION_MODULES_PER_CASE} files`,
        );
      }
      observedPaths.add(path);
      validated.writeRecord(
        `${PRODUCTION_MODULE_RECORD_PREFIX}${JSON.stringify({ path })}\n`,
      );
    },
    tsconfig: false,
  });
  return Object.freeze({
    async close() {
      await unregister();
    },
    paths() {
      return [...observedPaths].sort();
    },
  });
}

function productionModulePath(url, options) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== "file:") return undefined;
  const absolutePath = realpathSync(fileURLToPath(parsedUrl));
  const pathWithinProductionTree = relative(
    options.productionRoot,
    absolutePath,
  );
  if (
    pathWithinProductionTree.length === 0 ||
    isAbsolute(pathWithinProductionTree) ||
    pathWithinProductionTree.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    return undefined;
  }
  return relative(options.repositoryRoot, absolutePath).split(sep).join("/");
}

function validateOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new Error("production module tracker options must be an object");
  }
  if (typeof options.writeRecord !== "function") {
    throw new Error("production module tracker requires a record writer");
  }
  const repositoryRoot = realpathSync(resolve(options.repositoryRoot));
  const productionRoot = realpathSync(resolve(options.productionRoot));
  const relativeProductionRoot = relative(repositoryRoot, productionRoot);
  if (
    relativeProductionRoot.length === 0 ||
    isAbsolute(relativeProductionRoot) ||
    relativeProductionRoot.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new Error("production module root must be inside the repository");
  }
  return {
    productionRoot,
    repositoryRoot,
    writeRecord: options.writeRecord,
  };
}
