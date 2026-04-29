#!/usr/bin/env node
import "./node-compat.js";
import { runCli } from '../cli/index.js';

void (async () => {
  try {
    const exitCode = await runCli();
    process.exitCode = exitCode;
  } catch (error) {
    process.exitCode = 1;
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
  }
})();
