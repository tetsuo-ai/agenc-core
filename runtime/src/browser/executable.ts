/**
 * Chromium-family executable resolution for the browser tool.
 *
 * Reuses the browser catalog from `utils/agencInChrome/common.ts` (the same
 * table the Chrome-extension bridge uses) so a single place knows the binary
 * names per browser. Resolution order: an explicit configured path, then the
 * detection order (chrome, brave, arc, edge, chromium, vivaldi, opera) probed
 * against common absolute install dirs and `PATH`. Inside AgenC's Linux
 * sandbox, detection passes over snap packages and a configured one is refused.
 *
 * @module
 */

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { platform } from "node:os";
import {
  BROWSER_DETECTION_ORDER,
  CHROMIUM_BROWSERS,
} from "../utils/agencInChrome/common.js";

export type BrowserExecutableErrorCode =
  | "BROWSER_EXECUTABLE_NOT_FOUND"
  | "BROWSER_EXECUTABLE_SNAP_IN_SANDBOX";

export class BrowserExecutableError extends Error {
  readonly code: BrowserExecutableErrorCode;
  constructor(
    message: string,
    code: BrowserExecutableErrorCode = "BROWSER_EXECUTABLE_NOT_FOUND",
  ) {
    super(message);
    this.name = "BrowserExecutableError";
    this.code = code;
  }
}

export interface ResolveBrowserExecutableOptions {
  /** The browser starts inside AgenC's sandbox (the session mode requires one). */
  readonly insideAgencSandbox?: boolean;
  /** Test seam for the host platform. */
  readonly platform?: NodeJS.Platform;
  /** Test seam for the install dirs searched before `PATH` on Linux. */
  readonly linuxBinDirs?: readonly string[];
}

/** What to do when the only browser AgenC could use is a snap package. */
export const SNAP_IN_SANDBOX_HINT =
  "Snap packages cannot start inside AgenC's sandbox. Install Google Chrome or a non-snap Chromium, or set [browser].executable_path to one.";

/** How much of a script is read to find the snap it runs. */
const SCRIPT_SCAN_BYTES = 64 * 1024;

/**
 * Whether `file` starts a snap package. snapd installs each app as a link to
 * its `snap` launcher (/snap/bin/chromium -> /usr/bin/snap), and Ubuntu's
 * chromium-browser package installs a script that runs /snap/bin/chromium.
 * Neither can start inside AgenC's Linux sandbox: `snap run` cannot create
 * its systemd scope for a sandboxed process, and the launcher started under
 * its real name parses Chromium's flags as its own. The browser binary inside
 * a snap's own directory is a plain executable and is not matched.
 */
export function startsSnapPackage(file: string): boolean {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  return basename(real) === "snap" || scriptRunsSnap(real);
}

function scriptRunsSnap(file: string): boolean {
  let fd: number | undefined;
  try {
    // A FIFO or device would block the read or never end.
    if (!statSync(file).isFile()) return false;
    fd = openSync(file, "r");
    const head = Buffer.alloc(SCRIPT_SCAN_BYTES);
    const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8");
    return text.startsWith("#!") && text.includes("/snap/bin/");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function snapInSandboxError(file: string): BrowserExecutableError {
  return new BrowserExecutableError(
    `${file} is a snap package. ${SNAP_IN_SANDBOX_HINT}`,
    "BROWSER_EXECUTABLE_SNAP_IN_SANDBOX",
  );
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

interface DetectedExecutable {
  readonly found?: string;
  /** The first snap package passed over, when snaps cannot start. */
  readonly skippedSnap?: string;
}

function detectExecutable(
  env: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform,
  linuxBinDirs: readonly string[],
  skipSnaps: boolean,
): DetectedExecutable {
  if (hostPlatform === "darwin") {
    const found = MACOS_APP_EXECUTABLES.find((p) => existsSync(p));
    return found === undefined ? {} : { found };
  }
  // Linux / WSL. Prefer well-known absolute dirs (avoids picking up user PATH
  // shims that may not forward the CDP pipe fds), then fall back to PATH.
  const searchDirs = [...linuxBinDirs, ...pathDirs(env)];
  let skippedSnap: string | undefined;
  for (const binary of linuxBinaryCandidates()) {
    for (const dir of searchDirs) {
      const candidate = join(dir, binary);
      if (!existsSync(candidate)) continue;
      if (skipSnaps && startsSnapPackage(candidate)) {
        skippedSnap ??= candidate;
        continue;
      }
      return { found: candidate };
    }
  }
  return skippedSnap === undefined ? {} : { skippedSnap };
}

/**
 * Resolve the Chromium executable to launch. Throws
 * {@link BrowserExecutableError} when nothing usable is found.
 */
export function resolveBrowserExecutable(
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveBrowserExecutableOptions = {},
): string {
  const hostPlatform = options.platform ?? platform();
  const refuseSnaps = options.insideAgencSandbox === true && hostPlatform === "linux";
  if (explicitPath !== undefined && explicitPath.length > 0) {
    if (!existsSync(explicitPath)) {
      throw new BrowserExecutableError(
        `configured browser executable not found: ${explicitPath}`,
      );
    }
    if (refuseSnaps && startsSnapPackage(explicitPath)) {
      throw snapInSandboxError(explicitPath);
    }
    return explicitPath;
  }
  const detected = detectExecutable(
    env, hostPlatform, options.linuxBinDirs ?? LINUX_BIN_DIRS, refuseSnaps,
  );
  if (detected.found !== undefined) return detected.found;
  if (detected.skippedSnap !== undefined) throw snapInSandboxError(detected.skippedSnap);
  throw new BrowserExecutableError(
    "no Chromium-family browser found: install Chrome/Chromium/Brave/Edge or set [browser].executable_path (AGENC_BROWSER_EXECUTABLE)",
  );
}
