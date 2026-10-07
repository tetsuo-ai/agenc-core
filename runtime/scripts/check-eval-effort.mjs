#!/usr/bin/env node
// Refuse a compare-agents.sh run whose AgenC eval home is not pinned to the
// reasoning effort that Hermes and OpenCode get as a flag:
//   check-eval-effort.mjs <agenc-eval-home> <effort>
// compare-agents.sh starts AgenC without AGENC_PROFILE or AGENC_EFFORT_LEVEL,
// so its effort is the top-level reasoning_effort in the home's config.toml,
// read here with AgenC's own TOML parser. The file is never rewritten.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToml } from "../src/config/loader.ts";

export function checkEvalEffort({ home, effort }) {
  const path = join(home, "config.toml");
  let configured;
  try {
    configured = parseToml(readFileSync(path, "utf8")).reasoning_effort;
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
  if (configured === effort) return;
  const found = configured === undefined
    ? "does not set reasoning_effort"
    : `sets reasoning_effort = ${JSON.stringify(configured)}`;
  throw new Error(
    `${path} ${found}, but EFFORT is ${JSON.stringify(effort)}; ` +
      `set reasoning_effort = ${JSON.stringify(effort)} there so every agent runs at the same effort`,
  );
}

function isEntrypoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    checkEvalEffort({ home: process.argv[2], effort: process.argv[3] });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
