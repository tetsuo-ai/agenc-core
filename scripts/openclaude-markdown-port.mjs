#!/usr/bin/env node
/**
 * Wholesale-port openclaude markdown rendering pipeline →
 * AgenC runtime/src/tui/{components,utils}/.
 *
 * - copies openclaude src/components/{Markdown,MarkdownTable}.tsx
 * - copies openclaude src/utils/{markdown,cliHighlight,hash,hyperlink}.ts
 * - cherry-picks stripPromptXMLTags into runtime/src/tui/utils/messages.ts
 * - cherry-picks ThemeName type into runtime/src/tui/utils/theme.ts
 * - writes a useSettings shim returning AgenC defaults
 *
 * Idempotent — re-running reproduces the same output.
 *
 * The transformation rules live in openclaude-markdown-transform.mjs so
 * the parity gate uses the exact same rules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-markdown-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

// ---- 1:1 wholesale-copy plan ----

const COPIES = [
  { src: "components/Markdown.tsx", dst: "components/Markdown.tsx" },
  { src: "components/MarkdownTable.tsx", dst: "components/MarkdownTable.tsx" },
  { src: "utils/markdown.ts", dst: "utils/markdown.ts" },
  { src: "utils/cliHighlight.ts", dst: "utils/cliHighlight.ts" },
  { src: "utils/hash.ts", dst: "utils/hash.ts" },
  { src: "utils/hyperlink.ts", dst: "utils/hyperlink.ts" },
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

// ---- cherry-picked stub files (not byte-copies) ----

const MESSAGES_TS = `// Cherry-picked from openclaude src/utils/messages.ts.
// Only stripPromptXMLTags is consumed by the wholesale-ported markdown
// pipeline — the rest of openclaude's messages.ts pulls Anthropic SDK +
// OpenClaude tooling that don't apply to AgenC. This file is the AgenC
// boundary for that specific function so the markdown port resolves
// without dragging the rest of OpenClaude's runtime in.

const STRIPPED_TAGS_RE =
  /<(?:user-prompt|user-memory|user-system-reminder|system-reminder)[^>]*>[\\s\\S]*?<\\/(?:user-prompt|user-memory|user-system-reminder|system-reminder)>/g;

export function stripPromptXMLTags(content: string): string {
  return content.replace(STRIPPED_TAGS_RE, "").trim();
}
`;

const THEME_TS = `// Cherry-picked theme boundary for the wholesale-ported markdown
// pipeline.
//
// openclaude's markdown utility takes \`theme: ThemeName\` parameters
// where ThemeName is a string union ('light' | 'dark' | …) and resolves
// the actual theme via openclaude's color() signature
// \`color(name, themeName)\`. AgenC's color() signature takes the
// resolved Theme object instead: \`color(name, theme: Theme)\`. To keep
// the wholesale-ported markdown source byte-equivalent, alias ThemeName
// to AgenC's Theme object type — the parameter slot stays named
// \`ThemeName\` (matching openclaude verbatim) but is the AgenC Theme
// at runtime, which is what the ported markdown.ts actually feeds into
// AgenC's color().

export type { Theme as ThemeName } from "../theme.js";
`;

const USE_SETTINGS_TS = `// AgenC useSettings shim.
//
// Wired into the markdown wholesale-port. openclaude's useSettings reads
// from their per-user settings store; AgenC has its own settings layer
// but markdown rendering currently consumes only one flag
// (syntaxHighlightingDisabled), and AgenC has no toggle for it today.
// This shim returns the defaults; if AgenC adds a syntax-highlight
// toggle later, replace the body with the real settings read.

export interface AgenCMarkdownSettings {
  readonly syntaxHighlightingDisabled: boolean;
}

export function useSettings(): AgenCMarkdownSettings {
  return { syntaxHighlightingDisabled: false };
}
`;

const FIGURES_TS = `// Cherry-picked from openclaude src/constants/figures.ts.
// Only constants consumed by the wholesale-ported markdown pipeline are
// included here; the rest of figures.ts pulls openclaude env utilities
// AgenC-irrelevant transitive deps. Add more constants as additional
// areas are ported.

export const BLOCKQUOTE_BAR = "▎"; // ▎ - blockquote line prefix
`;

const DEBUG_TS = `// Re-export the wholesale-ported ink-side debug helpers at the AgenC
// utils-level path so wholesale-copied openclaude code that imports
// \`'./debug.js'\` (sibling of utils/markdown.ts) resolves to the same
// vendored implementation the ink/ port already ships.

export { logForDebugging, type DebugLogLevel } from "../ink/vendored/debug.js";
`;

function writeIfChanged(absPath, content) {
  ensureDir(absPath);
  if (fs.existsSync(absPath) && fs.readFileSync(absPath, "utf8") === content) {
    return false;
  }
  fs.writeFileSync(absPath, content);
  return true;
}

let cherryPicked = 0;
const cherryFiles = [
  ["utils/messages.ts", MESSAGES_TS],
  ["utils/theme.ts", THEME_TS],
  ["utils/debug.ts", DEBUG_TS],
  ["constants/figures.ts", FIGURES_TS],
  ["hooks/useSettings.ts", USE_SETTINGS_TS],
];
for (const [rel, content] of cherryFiles) {
  if (writeIfChanged(path.join(AG_TUI, rel), content)) {
    cherryPicked += 1;
  }
}

console.log(`Markdown wholesale port complete:`);
console.log(`  copied (with transform): ${copied}`);
console.log(`  cherry-picked utility:   ${cherryPicked}`);
