#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(SCRIPT_DIR, "check-tui-e2e", "runner.mjs");

const result = spawnSync(
  process.execPath,
  [runner, "--filter", "workbench-buffer-neovim"],
  {
    cwd: path.resolve(SCRIPT_DIR, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      AGENC_TUI_WORKBENCH: "1",
      AGENC_BUFFER_NVIM_USE_INIT: "0",
    },
  },
);

process.exit(result.status ?? 1);
