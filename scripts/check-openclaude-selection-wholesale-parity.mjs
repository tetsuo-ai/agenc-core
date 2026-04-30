#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { transform } from "./openclaude-selection-transform.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = path.resolve(
  SCRIPT_DIR,
  "../parity/openclaude-selection-wholesale-parity.json",
);
const OC_SRC = "/home/tetsuo/git/openclaude/src";
const AG_TUI = path.resolve(SCRIPT_DIR, "../runtime/src/tui");

const FORBIDDEN = [
  /TODO parity/i,
  /implementation placeholder/i,
  /placeholder implementation/i,
  /partial implementation/i,
  /stub implementation/i,
  /\bstubbed\b/i,
  /not implemented/i,
  /\bnot yet\b/i,
];

const COPY_PAIRS = [
  { oc: "hooks/useCopyOnSelect.ts", ag: "hooks/useCopyOnSelect.ts" },
  {
    oc: "components/ScrollKeybindingHandler.tsx",
    ag: "components/ScrollKeybindingHandler.tsx",
  },
];

const CHERRY_PICKED = ["utils/config-shim.ts"];

function scanForbidden(p) {
  const out = [];
  fs.readFileSync(p, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const r of FORBIDDEN) {
        if (r.test(line)) {
          out.push(`${p}:${i + 1}: ${line.trim()}`);
          break;
        }
      }
    });
  return out;
}

function main() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
  const errors = [];

  for (const f of ["contractName", "scope", "sourceRoot", "targetRoot"]) {
    if (typeof matrix[f] !== "string" || !matrix[f].trim()) {
      errors.push(`matrix.${f} must be non-empty`);
    }
  }
  if (!Array.isArray(matrix.rows) || !matrix.rows.length) {
    errors.push("matrix.rows must be non-empty");
  }

  for (const row of matrix.rows ?? []) {
    const targetAbs = path.isAbsolute(row.target)
      ? row.target
      : path.resolve(path.dirname(MATRIX_PATH), "..", row.target);
    if (fs.existsSync(targetAbs) && fs.statSync(targetAbs).isFile()) {
      for (const m of scanForbidden(targetAbs)) {
        errors.push(`${row.id}: forbidden language: ${m}`);
      }
    }
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
        `transform-drift: runtime/src/tui/${ag} differs from openclaude src/${oc} after transform — re-run scripts/openclaude-selection-port.mjs`,
      );
    }
  }

  for (const rel of CHERRY_PICKED) {
    if (!fs.existsSync(path.join(AG_TUI, rel))) {
      errors.push(`adapter file missing: runtime/src/tui/${rel}`);
    }
  }

  if (errors.length) {
    console.error(
      `Implementation contract FAILED: ${matrix.contractName}`,
    );
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(`Implementation contract passed: ${matrix.contractName}`);
  console.log(`Rows validated: ${matrix.rows.length}`);
  console.log(
    `Wholesale 1:1 byte-verified: ${COPY_PAIRS.length} files post-transform`,
  );
  console.log(`Cherry-picks / adapters present: ${CHERRY_PICKED.length}`);
}

main();
