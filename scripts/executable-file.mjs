import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import process from "node:process";

export function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    }
    const probe = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return probe.error === undefined;
  } catch {
    return false;
  }
}
