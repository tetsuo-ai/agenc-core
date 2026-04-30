#!/usr/bin/env node
/**
 * Wholesale-port openclaude selection / hit-testing orchestration above
 * the renderer → AgenC runtime/src/tui/{hooks,components,utils}/.
 *
 * - copies openclaude src/hooks/useCopyOnSelect.ts
 * - copies openclaude src/components/ScrollKeybindingHandler.tsx
 * - writes a getGlobalConfig shim returning { copyOnSelect: true }
 *   default at runtime/src/tui/utils/config-shim.ts
 *
 * Idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-selection-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPIES = [
  { src: "hooks/useCopyOnSelect.ts", dst: "hooks/useCopyOnSelect.ts" },
  {
    src: "components/ScrollKeybindingHandler.tsx",
    dst: "components/ScrollKeybindingHandler.tsx",
  },
];

const CONFIG_SHIM = `// AgenC global-config shim for the selection wholesale-port.
//
// openclaude's getGlobalConfig() reads from their global config store;
// AgenC has its own config layer but no copyOnSelect toggle today, so
// this shim returns the openclaude default. Replace the body with the
// real AgenC config read once a copyOnSelect flag is introduced.

export interface AgenCGlobalConfigShim {
  readonly copyOnSelect: boolean;
}

export function getGlobalConfig(): AgenCGlobalConfigShim {
  return { copyOnSelect: true };
}
`;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

let copied = 0;
for (const { src, dst } of COPIES) {
  const srcAbs = path.join(OC_SRC, src);
  const dstAbs = path.join(AG_TUI, dst);
  ensureDir(dstAbs);
  fs.writeFileSync(dstAbs, transform(fs.readFileSync(srcAbs, "utf8"), dst));
  copied += 1;
}

const shimAbs = path.join(AG_TUI, "utils/config-shim.ts");
ensureDir(shimAbs);
const cherryWritten =
  !fs.existsSync(shimAbs) ||
  fs.readFileSync(shimAbs, "utf8") !== CONFIG_SHIM;
if (cherryWritten) {
  fs.writeFileSync(shimAbs, CONFIG_SHIM);
}

console.log(`Selection wholesale port complete:`);
console.log(`  copied (with transform): ${copied}`);
console.log(`  config-shim updated:     ${cherryWritten ? "yes" : "no-op"}`);
