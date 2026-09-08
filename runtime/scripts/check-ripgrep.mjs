import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { register } from "tsx/cjs/api";

async function loadRipgrepResolver() {
  const unregister = register();
  try {
    return await tsImport("../src/utils/ripgrep.ts", {
      parentURL: import.meta.url,
      tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    });
  } finally {
    unregister();
  }
}

export async function checkRipgrep({
  loadResolver = loadRipgrepResolver,
  report = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const resolver = await loadResolver();
  const status = resolver.getRipgrepStatus();
  if (!await resolver.probeRipgrepAvailable()) {
    throw new Error(
      `Ripgrep preflight failed (${status.mode}: ${status.path}). Reinstall dependencies including optional platform packages, or install rg on PATH.`,
    );
  }
  report(`Ripgrep preflight passed (${status.mode}: ${status.path}).`);
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkRipgrep();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
