import { registerHooks } from "node:module";

export const JSONC_PARSER_ESM_ENTRY = "jsonc-parser/lib/esm/main.js";
export const JSONC_PARSER_NODE_ADAPTER_URL = new URL(
  "./jsonc-parser-node-adapter.mjs",
  import.meta.url,
).href;

export function resolveBenchmarkModuleCompatibility(
  specifier,
  context,
  nextResolve,
) {
  if (specifier !== JSONC_PARSER_ESM_ENTRY) {
    return nextResolve(specifier, context);
  }
  return {
    shortCircuit: true,
    url: JSONC_PARSER_NODE_ADAPTER_URL,
  };
}

export function registerBenchmarkModuleCompatibility() {
  return registerHooks({ resolve: resolveBenchmarkModuleCompatibility });
}
