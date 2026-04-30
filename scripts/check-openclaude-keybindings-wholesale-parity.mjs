#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-keybindings-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = path.resolve(SCRIPT_DIR, "../parity/openclaude-keybindings-wholesale-parity.json");
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPY_PAIRS = [
  { oc: "keybindings/KeybindingProviderSetup.tsx", ag: "keybindings/KeybindingProviderSetup.tsx" },
  { oc: "keybindings/template.ts", ag: "keybindings/template.ts" },
  { oc: "keybindings/useKeybinding.ts", ag: "keybindings/useKeybinding.ts" },
];

function main() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX, "utf8"));
  const errors = [];
  for (const { oc, ag } of COPY_PAIRS) {
    const ocAbs = path.join(OC_SRC, oc);
    const agAbs = path.join(AG_TUI, ag);
    if (!fs.existsSync(ocAbs)) errors.push(`source missing: ${ocAbs}`);
    else if (!fs.existsSync(agAbs)) errors.push(`target missing: ${agAbs}`);
    else {
      const expected = transform(fs.readFileSync(ocAbs, "utf8"), ag);
      const actual = fs.readFileSync(agAbs, "utf8");
      if (expected !== actual)
        errors.push(`transform-drift: runtime/src/tui/${ag}`);
    }
  }
  if (errors.length) {
    console.error(`Implementation contract FAILED: ${matrix.contractName}`);
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
  console.log(`Wholesale 1:1 byte-verified: ${COPY_PAIRS.length} files post-transform`);
}

main();
