#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-search-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = path.resolve(SCRIPT_DIR, "../parity/openclaude-search-wholesale-parity.json");
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPY_PAIRS = [
  { oc: "components/SearchBox.tsx", ag: "components/SearchBox.tsx" },
  { oc: "components/GlobalSearchDialog.tsx", ag: "components/GlobalSearchDialog.tsx" },
  { oc: "components/HistorySearchDialog.tsx", ag: "components/HistorySearchDialog.tsx" },
  { oc: "utils/transcriptSearch.ts", ag: "utils/transcriptSearch.ts" },
  { oc: "hooks/useSearchInput.ts", ag: "hooks/useSearchInput.ts" },
  { oc: "hooks/useHistorySearch.ts", ag: "hooks/useHistorySearch.ts" },
];

const CHERRY = [
  "context/overlayContext.tsx",
  "history.ts",
  "utils/config.ts",
  "utils/format.ts",
  "utils/highlightMatch.tsx",
  "utils/editor.ts",
  "utils/readFileInRange.ts",
  "utils/ripgrep.ts",
  "utils/permissions/filesystem.ts",
  "utils/Cursor.ts",
  "components/PromptInput/inputModes.ts",
  "types/textInputTypes.ts",
  "types/message.ts",
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
        errors.push(`transform-drift: runtime/src/tui/${ag} differs from openclaude src/${oc}`);
    }
  }
  for (const rel of CHERRY) {
    if (!fs.existsSync(path.join(AG_TUI, rel)))
      errors.push(`cherry-pick missing: runtime/src/tui/${rel}`);
  }
  for (const rel of [
    "dialogs/GlobalSearchDialog.tsx",
    "dialogs/HistorySearchDialog.tsx",
  ]) {
    if (fs.existsSync(path.join(AG_TUI, rel)))
      errors.push(`legacy file still present: runtime/src/tui/${rel}`);
  }
  if (errors.length) {
    console.error(`Implementation contract FAILED: ${matrix.contractName}`);
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
  console.log(`Wholesale 1:1 byte-verified: ${COPY_PAIRS.length} files post-transform`);
  console.log(`Cherry-picks: ${CHERRY.length}`);
}

main();
