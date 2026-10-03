#!/usr/bin/env node
// Best-effort install preparation. Source workspaces need not have dist yet.
import { existsSync } from "node:fs";

const helper = new URL("../dist/bin/prepare-peer-credentials.js", import.meta.url);
if (existsSync(helper)) {
  try {
    await import(helper.href);
  } catch (error) {
    process.stderr.write(
      `agenc: native peer credential preparation skipped (${error?.message ?? error}); startup will retry.\n`,
    );
  }
}
