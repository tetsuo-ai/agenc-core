#!/usr/bin/env node
/**
 * Wholesale-port openclaude-only keybinding files →
 * AgenC runtime/src/tui/keybindings/.
 *
 * Only the OC-only files are copied here. AgenC's existing keybinding
 * infrastructure (defaultBindings.ts vocabulary, KeybindingContext,
 * loadUserBindings, match/parser/resolver/schema/validate/shortcutFormat,
 * types.ts, useKeybindings.ts) defines AgenC's binding vocabulary +
 * runtime; replacing those wholesale would break every AgenC consumer
 * (chat:cycleMode, app:toggleTasks, etc.) since openclaude's vocabulary
 * is different.
 *
 * Copied here:
 *   - KeybindingProviderSetup.tsx
 *   - template.ts
 *   - useKeybinding.ts (singular file — AgenC's useKeybinding wrapper
 *     already lives in useKeybindings.ts and re-exports from here)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-keybindings-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPIES = [
  { src: "keybindings/KeybindingProviderSetup.tsx", dst: "keybindings/KeybindingProviderSetup.tsx" },
  { src: "keybindings/template.ts", dst: "keybindings/template.ts" },
  { src: "keybindings/useKeybinding.ts", dst: "keybindings/useKeybinding.ts" },
];

let copied = 0;
for (const { src, dst } of COPIES) {
  const srcAbs = path.join(OC_SRC, src);
  const dstAbs = path.join(AG_TUI, dst);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.writeFileSync(dstAbs, transform(fs.readFileSync(srcAbs, "utf8"), dst));
  copied += 1;
}

console.log(`Keybindings wholesale port complete: copied ${copied}`);
