#!/usr/bin/env node
/**
 * Fail if any runtime/src TypeScript source contains a raw NUL (0x00) byte.
 * Intentional separators must use escapes (e.g. "\\u0000"), not raw bytes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "runtime", "src");
const bad = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) {
      const buf = readFileSync(p);
      if (buf.includes(0)) bad.push(p);
    }
  }
}

walk(root);
if (bad.length > 0) {
  console.error("NUL byte(s) found in:");
  for (const p of bad) console.error(" ", p);
  process.exit(1);
}
console.log("ok: no raw NUL bytes under runtime/src");
