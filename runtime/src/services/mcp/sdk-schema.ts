import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Node 26 can require ESM synchronously. Resolve with import conditions so these
 * handlers share schema/error identities with the SDK clients (not its CJS copy).
 */
export function loadMcpTypes(): typeof import("@modelcontextprotocol/sdk/types.js") {
  return require(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/types.js")));
}

export function loadMcpStdio(): typeof import("@modelcontextprotocol/sdk/shared/stdio.js") {
  return require(fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/shared/stdio.js")));
}
