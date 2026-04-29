#!/usr/bin/env node
import { prefetchRuntimeOnInstall } from "../lib/runtime-manager.js";

await prefetchRuntimeOnInstall().catch(() => {
  // Best effort only. First-run lazy install remains the authoritative path.
});
