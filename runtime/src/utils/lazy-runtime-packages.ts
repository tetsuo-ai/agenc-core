import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Node 26 can require ESM synchronously. Resolve using import conditions so
// these operations use the same exports as static ESM consumers. Keeping the
// load synchronous avoids adding a yield between authority/lifecycle checks
// and the operation. Failed loads propagate; no fallback bypasses the caller.
export function loadDiff(): typeof import("diff") {
  return require(fileURLToPath(import.meta.resolve("diff")));
}

export function loadTar(): typeof import("tar") {
  return require(fileURLToPath(import.meta.resolve("tar")));
}

export function loadJsonRpc(): typeof import("vscode-jsonrpc/node") {
  return require(fileURLToPath(import.meta.resolve("vscode-jsonrpc/node")));
}

export function loadChokidar(): typeof import("chokidar").default {
  return require(fileURLToPath(import.meta.resolve("chokidar"))).default;
}

export function loadYaml(): typeof import("js-yaml") {
  return require(fileURLToPath(import.meta.resolve("js-yaml")));
}
