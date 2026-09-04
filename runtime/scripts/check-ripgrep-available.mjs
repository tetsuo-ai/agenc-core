#!/usr/bin/env node
/**
 * Cheap pr-fast preflight: system `rg` or the packaged @vscode/ripgrep binary
 * must be present. Packaging drift fails here instead of as an empty agent catalog.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));

function systemRgOnPath() {
  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const name = process.platform === "win32" ? `rg${extension}` : "rg";
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function packagedRgPath() {
  try {
    const { rgPath } = require("@vscode/ripgrep");
    if (typeof rgPath === "string" && existsSync(rgPath)) return rgPath;
  } catch {
    // optional platform package may be absent
  }
  return undefined;
}

const system = systemRgOnPath();
const packaged = packagedRgPath();
if (system === undefined && packaged === undefined) {
  process.stderr.write(
    "Neither system rg nor packaged @vscode/ripgrep is executable. Run npm install or install ripgrep.\n",
  );
  process.exit(1);
}
const rgDetail =
  system !== undefined ? `system=${system}` : `packaged=${packaged}`;
process.stdout.write(`ripgrep ok (${runtimeRoot}): ${rgDetail}\n`);
