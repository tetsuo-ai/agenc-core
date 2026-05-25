#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const matrixPath = path.resolve(import.meta.dirname, "../parity/embedded-neovim-buffer.json");
const checkerPath = path.resolve(import.meta.dirname, "../../../../.claude/skills/implementation-contract/scripts/check_contract.mjs");
const rowReviewMode = process.env.AGENC_EMBEDDED_NEOVIM_CONTRACT_ROW_REVIEW === "1";
const defaultFlags = [
  "--require-inventory",
  "--require-edge-cases",
  "--require-reviews",
  "--require-commands",
  "--run-commands",
];
const checkerFlags = rowReviewMode
  ? defaultFlags.filter((flag) => flag !== "--require-reviews" && flag !== "--run-commands")
  : defaultFlags;
const result = spawnSync(process.execPath, [
  checkerPath,
  "--matrix",
  matrixPath,
  ...checkerFlags,
  ...process.argv.slice(2),
], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
