#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const matrixPath = path.resolve(import.meta.dirname, "../parity/codex-thread-parity.json");
const checkerPath = path.resolve(
  os.homedir(),
  ".codex/skills/implementation-contract/scripts/check_contract.mjs",
);
const result = spawnSync(process.execPath, [checkerPath, "--matrix", matrixPath], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
