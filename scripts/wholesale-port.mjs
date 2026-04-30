#!/usr/bin/env node
/**
 * Wholesale-port openclaude src/ink/ → AgenC runtime/src/tui/ink/.
 *
 * For every file in openclaude that AgenC has at the same relative path,
 * read openclaude's content, apply the shared transform, and write the
 * result over AgenC's. Files in KEEP_AGENC_VERSION are skipped (AgenC
 * keeps its own version). Files openclaude has but AgenC doesn't are
 * surfaced as a warning — those would be missing from the port and
 * need a matrix row to either add them or document why they're omitted.
 *
 * Idempotent: re-running on already-ported code reproduces the same
 * output (the transform's regexes are designed to be no-ops on
 * already-transformed input).
 *
 * The shared transform lives in openclaude-ink-transform.mjs so the
 * matrix gate uses the same rules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEEP_AGENC_VERSION,
  transform,
} from "./openclaude-ink-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = "/home/tetsuo/git/openclaude/src/ink";
const DST_ROOT = path.resolve(SCRIPT_DIR, "../runtime/src/tui/ink");

function listFiles(dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(abs, rel));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      out.push(rel);
    }
  }
  return out;
}

const sourceFiles = listFiles(SRC_ROOT);
let copied = 0;
let skippedKeepAgenc = 0;
let missingDst = 0;

for (const rel of sourceFiles) {
  if (KEEP_AGENC_VERSION.has(rel)) {
    skippedKeepAgenc += 1;
    continue;
  }
  const dstAbs = path.join(DST_ROOT, rel);
  if (!fs.existsSync(dstAbs)) {
    missingDst += 1;
    continue;
  }
  const original = fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");
  fs.writeFileSync(dstAbs, transform(original, rel));
  copied += 1;
}

console.log(`Wholesale port complete:`);
console.log(`  copied:               ${copied}`);
console.log(`  kept AgenC version:   ${skippedKeepAgenc}`);
console.log(`  missing in AgenC:     ${missingDst}`);
