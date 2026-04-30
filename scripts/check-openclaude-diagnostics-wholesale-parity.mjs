#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-diagnostics-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = path.resolve(
  SCRIPT_DIR,
  "../parity/openclaude-diagnostics-wholesale-parity.json",
);
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPY_PAIRS = [
  { oc: "components/DiagnosticsDisplay.tsx", ag: "components/DiagnosticsDisplay.tsx" },
  { oc: "components/MessageResponse.tsx", ag: "components/MessageResponse.tsx" },
  { oc: "components/CtrlOToExpand.tsx", ag: "components/CtrlOToExpand.tsx" },
];

const CHERRY_PICKED = [
  "services/diagnosticTracking.ts",
  "utils/attachments.ts",
  "utils/cwd.ts",
  "keybindings/useShortcutDisplay.ts",
  "components/messageActions.tsx",
];

function main() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX, "utf8"));
  const errors = [];
  if (!Array.isArray(matrix.rows) || !matrix.rows.length) {
    errors.push("matrix.rows must be non-empty");
  }

  for (const { oc, ag } of COPY_PAIRS) {
    const ocAbs = path.join(OC_SRC, oc);
    const agAbs = path.join(AG_TUI, ag);
    if (!fs.existsSync(ocAbs)) {
      errors.push(`source missing: ${ocAbs}`);
      continue;
    }
    if (!fs.existsSync(agAbs)) {
      errors.push(`target missing: ${agAbs}`);
      continue;
    }
    const expected = transform(fs.readFileSync(ocAbs, "utf8"), ag);
    const actual = fs.readFileSync(agAbs, "utf8");
    if (expected !== actual) {
      errors.push(
        `transform-drift: runtime/src/tui/${ag} differs from openclaude src/${oc} after transform — re-run scripts/openclaude-diagnostics-port.mjs`,
      );
    }
  }
  for (const rel of CHERRY_PICKED) {
    if (!fs.existsSync(path.join(AG_TUI, rel))) {
      errors.push(`cherry-pick missing: runtime/src/tui/${rel}`);
    }
  }
  // AgenC frame-monitor must be deleted.
  for (const rel of [
    "diagnostics/frame-monitor.ts",
    "diagnostics/frame-monitor.test.ts",
  ]) {
    if (fs.existsSync(path.join(AG_TUI, rel))) {
      errors.push(`legacy file still present: runtime/src/tui/${rel}`);
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
  console.log(`Cherry-picks: ${CHERRY_PICKED.length}`);
}

main();
