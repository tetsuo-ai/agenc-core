#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-search-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const COPIES = [
  { src: "components/SearchBox.tsx", dst: "components/SearchBox.tsx" },
  { src: "components/GlobalSearchDialog.tsx", dst: "components/GlobalSearchDialog.tsx" },
  { src: "components/HistorySearchDialog.tsx", dst: "components/HistorySearchDialog.tsx" },
  { src: "utils/transcriptSearch.ts", dst: "utils/transcriptSearch.ts" },
  { src: "hooks/useSearchInput.ts", dst: "hooks/useSearchInput.ts" },
  { src: "hooks/useHistorySearch.ts", dst: "hooks/useHistorySearch.ts" },
];

let copied = 0;
for (const { src, dst } of COPIES) {
  const srcAbs = path.join(OC_SRC, src);
  const dstAbs = path.join(AG_TUI, dst);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.writeFileSync(dstAbs, transform(fs.readFileSync(srcAbs, "utf8"), dst));
  copied += 1;
}

console.log(`Search wholesale port complete: copied ${copied}`);
