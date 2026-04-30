#!/usr/bin/env node
/**
 * Wholesale-port openclaude DiagnosticsDisplay + transitive UI deps →
 * AgenC runtime/src/tui/components/.
 *
 * 1:1 copies (with transform):
 *   - components/DiagnosticsDisplay.tsx
 *   - components/MessageResponse.tsx
 *   - components/CtrlOToExpand.tsx
 *
 * The cherry-picked AgenC adapters (utils/cwd.ts, utils/attachments.ts,
 * services/diagnosticTracking.ts, components/messageActions.tsx,
 * keybindings/useShortcutDisplay.ts) are written directly into the
 * AgenC tree by hand, not by this script — they're small extracts not
 * 1:1 copies.
 *
 * Idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-diagnostics-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPIES = [
  { src: "components/DiagnosticsDisplay.tsx", dst: "components/DiagnosticsDisplay.tsx" },
  { src: "components/MessageResponse.tsx", dst: "components/MessageResponse.tsx" },
  { src: "components/CtrlOToExpand.tsx", dst: "components/CtrlOToExpand.tsx" },
];

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

console.log(`Diagnostics wholesale port complete:`);
console.log(`  copied (with transform): ${copied}`);
