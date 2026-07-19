import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FEATURE_MODULE = new URL("../../../src/build/feature.ts", import.meta.url).href;
const RUNTIME_SRC = new URL("../../../src/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "bun:bundle") {
    return { url: FEATURE_MODULE, shortCircuit: true };
  }
  if (specifier.startsWith("src/")) {
    return nextResolve(new URL(specifier.slice("src/".length), RUNTIME_SRC).href, context);
  }
  return nextResolve(specifier, context);
}

/**
 * Mirror the runtime bundler's text-loader behavior for Markdown imports in
 * the standalone crash/recovery child. TypeScript is still handled by tsx.
 */
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".md")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)};`,
    };
  }

  return nextLoad(url, context);
}
