#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const matrixPath = path.resolve(
  import.meta.dirname,
  "../parity/tui-yolo-openclaude-parity.json",
);
const checkerPath = path.resolve(
  "/home/tetsuo/.codex/skills/implementation-contract/scripts/check_contract.mjs",
);

const result = spawnSync(
  process.execPath,
  [
    checkerPath,
    "--matrix",
    matrixPath,
    "--require-inventory",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
