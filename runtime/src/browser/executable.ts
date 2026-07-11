/**
 * Chromium-family executable resolution for the browser tool.
 *
 * Reuses the browser catalog from `utils/agencInChrome/common.ts` (the same
 * table the Chrome-extension bridge uses) so a single place knows the binary
 * names per browser. Resolution order: an explicit configured path, then the
 * detection order (chrome, brave, arc, edge, chromium, vivaldi, opera) probed
 * against common absolute install dirs and `PATH`.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:os";
import {
  BROWSER_DETECTION_ORDER,
  CHROMIUM_BROWSERS,
} from "../utils/agencInChrome/common.js";

export class BrowserExecutableError extends Error {
  readonly code = "BROWSER_EXECUTABLE_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "BrowserExecutableError";
  }
}

/** Common absolute dirs where distro/vendor packages land Chromium binaries. */
const LINUX_BIN_DIRS: readonly string[] = [
  "/usr/bin",
  "/usr/local/bin",
  "/opt/google/chrome",
  "/opt/brave.com/brave",
  "/opt/microsoft/msedge",
  "/snap/bin",
];

/** Inner Mach-O executables for the well-known macOS app bundles. */
const MACOS_APP_EXECUTABLES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function pathDirs(env: NodeJS.ProcessEnv): readonly string[] {
  return (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
}

function findOnDirs(binary: string, dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Ordered list of Linux binary names across all catalog browsers. */
function linuxBinaryCandidates(): readonly string[] {
  const names: string[] = [];
  for (const id of BROWSER_DETECTION_ORDER) {
    for (const binary of CHROMIUM_BROWSERS[id].linux.binaries) {
      if (!names.includes(binary)) names.push(binary);
    }
  }
  return names;
}

function detectExecutable(env: NodeJS.ProcessEnv): string | undefined {
  if (platform() === "darwin") {
    return MACOS_APP_EXECUTABLES.find((p) => existsSync(p));
  }
  // Linux / WSL. Prefer well-known absolute dirs (avoids picking up user PATH
  // shims that may not forward the CDP pipe fds), then fall back to PATH.
  const searchDirs = [...LINUX_BIN_DIRS, ...pathDirs(env)];
  for (const binary of linuxBinaryCandidates()) {
    const found = findOnDirs(binary, searchDirs);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Resolve the Chromium executable to launch. Throws
 * {@link BrowserExecutableError} when nothing usable is found.
 */
export function resolveBrowserExecutable(
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new BrowserExecutableError(
      `configured browser executable not found: ${explicitPath}`,
    );
  }
  const detected = detectExecutable(env);
  if (detected !== undefined) return detected;
  throw new BrowserExecutableError(
    "no Chromium-family browser found — install Chrome/Chromium/Brave/Edge or set [browser].executable_path (AGENC_BROWSER_EXECUTABLE)",
  );
}
