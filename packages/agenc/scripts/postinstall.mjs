#!/usr/bin/env node
// Runs on `npm install @tetsuo-ai/agenc`. Pre-fetches the platform runtime so
// the first `agenc` invocation is fast. Best-effort: a failure here (offline
// install, CI, etc.) is NOT fatal — the launcher fetches lazily on first run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Skip in obviously non-interactive / packaging contexts.
if (process.env.AGENC_SKIP_POSTINSTALL === "1" || process.env.CI === "true") {
  process.exit(0);
}

try {
  const { ensureRuntimeLaunch } = await import("../lib/runtime-manager.mjs");
  const launch = await ensureRuntimeLaunch();
  const helper = join(dirname(launch.runtimeBin), "prepare-peer-credentials.mjs");
  if (existsSync(helper)) {
    // Use the installed runtime's Node ABI and private library directory.
    // Preparation only warms the user cache; signed package bytes stay intact.
    const result = spawnSync(launch.nodeBin, [helper], {
      env: {
        ...process.env,
        ...(launch.nodeLibraryPath === undefined
          ? {}
          : { LD_LIBRARY_PATH: launch.nodeLibraryPath }),
      },
      stdio: "inherit",
      timeout: 30_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      process.stderr.write("agenc: native peer credential preparation skipped; startup will retry.\n");
    }
  }
} catch (err) {
  process.stderr.write(
    `agenc: runtime pre-fetch skipped (${err?.message ?? err}); it will be fetched on first run.\n`,
  );
  // Non-fatal by design.
}
