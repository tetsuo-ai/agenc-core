#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(runtimeDir, "..");
const webDistIndex = path.join(repoRoot, "web", "dist", "index.html");

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function main() {
  if (process.env.AGENC_SKIP_DASHBOARD_BUILD === "1") {
    process.stdout.write("[runtime] skipping dashboard asset build because AGENC_SKIP_DASHBOARD_BUILD=1\n");
    return;
  }

  process.stdout.write("[runtime] building @tetsuo-ai/web for dashboard assets\n");
  run("npm", ["run", "build", "--workspace=@tetsuo-ai/web"], repoRoot, {
    ...process.env,
    AGENC_DASHBOARD_BASE: "/ui/",
  });

  if (!existsSync(webDistIndex)) {
    throw new Error(
      `web dashboard build did not produce ${webDistIndex}`,
    );
  }

  process.stdout.write("[runtime] syncing dashboard assets into runtime/dist/dashboard\n");
  run("node", ["scripts/sync-dashboard-assets.mjs"], repoRoot);
}

main();
