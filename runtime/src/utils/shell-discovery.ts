/**
 * Default user-shell discovery.
 *
 * Port of the relevant subset of the Rust runtime shell discovery helpers.
 * `default_user_shell()` + `detect_shell_type()` + `get_shell_path()`.
 * Used by
 * `Session` bootstrap to populate `services.userShell` with a real
 * shell binding instead of the `/bin/sh` interface stub that
 * `bin/bootstrap.ts::buildDeferredServices` falls back to when no
 * discovery is wired.
 *
 * Kept separate from `utils/shell-config.ts`, which only implements
 * `agenc` alias detection across shell rc files. That module does not
 * discover the user's login shell and cannot construct a `UserShell`.
 *
 * Scope of this port:
 *   - Unix-first. Windows discovery is not wired (upstream uses
 *     PowerShell / cmd fallbacks behind `cfg!(windows)` gates). AgenC
 *     runtimes currently boot on Unix, so we match the Unix branch of
 *     `default_user_shell_from_path` and fall back to `/bin/sh` in any
 *     edge case.
 *   - Synchronous `fs.existsSync` + `statSync` only. Upstream uses the
 *     async libc `getpwuid_r` path for the user's login shell. AgenC
 *     reads `process.env.SHELL` + `os.userInfo().shell` which covers
 *     the same signal on Unix without the libc dance.
 *   - No shell snapshot. Upstream `Shell` carries a `shell_snapshot`
 *     watch receiver; gut keeps that slot on `SessionServices.shellSnapshotTx`
 *     and the discovered shell does not have to carry one.
 *
 * @module
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { userInfo } from "node:os";

import type { UserShell } from "../session/session.js";

/** Upstream `ShellType`. `Fish` is intentionally absent — upstream's
 *  `detect_shell_type` also does not recognize fish. */
export type ShellType = "zsh" | "bash" | "sh" | "powershell" | "cmd";

/** Structural equivalent of upstream `Shell` minus the snapshot receiver. */
export interface DiscoveredShell extends UserShell {
  readonly path: string;
  readonly shellType: ShellType;
  deriveExecArgs(input: string, useLoginShell: boolean): string[];
}

/**
 * Ordered fallbacks used when neither `$SHELL` nor the user's passwd
 * shell can be resolved. Matches upstream order for the `cfg!(target_os
 * = "macos")` branch (zsh first) — on Linux upstream prefers bash first
 * but zsh is just as common in our dev environments, so we start with
 * zsh and fall through to bash then sh. All three are present on a
 * normal GNU/Linux install.
 */
const UNIX_FALLBACK_PATHS: ReadonlyArray<{ path: string; type: ShellType }> = [
  { path: "/bin/zsh", type: "zsh" },
  { path: "/bin/bash", type: "bash" },
  { path: "/bin/sh", type: "sh" },
];

/**
 * Upstream `core/src/shell_detect.rs::detect_shell_type`. Given a path
 * or binary name, returns the shell family or `undefined` if unknown.
 */
export function detectShellType(path: string): ShellType | undefined {
  const name = basename(path).toLowerCase();
  const stem = name.endsWith(".exe") ? name.slice(0, -4) : name;
  if (stem === "zsh") return "zsh";
  if (stem === "bash") return "bash";
  if (stem === "sh") return "sh";
  if (stem === "pwsh" || stem === "powershell") return "powershell";
  if (stem === "cmd") return "cmd";
  return undefined;
}

function fileExists(path: string): boolean {
  try {
    const s = statSync(path);
    return s.isFile() || s.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Upstream `derive_exec_args` closure on `Shell`. */
function deriveExecArgsFor(
  shellType: ShellType,
  shellPath: string,
): (input: string, useLoginShell: boolean) => string[] {
  return (input: string, useLoginShell: boolean) => {
    if (shellType === "zsh" || shellType === "bash" || shellType === "sh") {
      const arg = useLoginShell ? "-lc" : "-c";
      return [shellPath, arg, input];
    }
    if (shellType === "powershell") {
      const args = [shellPath];
      if (!useLoginShell) args.push("-NoProfile");
      args.push("-Command", input);
      return args;
    }
    // cmd
    return [shellPath, "/c", input];
  };
}

function buildShell(path: string, type: ShellType): DiscoveredShell {
  return {
    path,
    shellType: type,
    deriveExecArgs: deriveExecArgsFor(type, path),
  };
}

/** Upstream `get_user_shell_path` (Unix arm). Reads `$SHELL` first,
 *  then `os.userInfo().shell`. The libc `getpwuid_r` dance upstream
 *  does is what populates `passwd.pw_shell`; `os.userInfo()` in Node
 *  returns the same field on Unix, so this is the direct equivalent
 *  without raw libc. */
function getUserShellPathUnix(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.SHELL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  try {
    const info = userInfo();
    const fromPasswd = (info as { shell?: string }).shell;
    if (typeof fromPasswd === "string" && fromPasswd.length > 0) {
      return fromPasswd;
    }
  } catch {
    // os.userInfo can throw with EACCES on hardened containers — treat
    // as "no signal" so the fallback chain runs.
  }
  return undefined;
}

function ultimateFallback(): DiscoveredShell {
  // Matches upstream `ultimate_fallback_shell` for the non-Windows arm.
  return buildShell("/bin/sh", "sh");
}

/**
 * Synchronous default-shell discovery. Mirrors upstream
 * `default_user_shell_from_path` for the Unix arm: prefer the user's
 * passwd/`$SHELL` path when it exists and we recognize the family,
 * otherwise walk the Unix fallback list, otherwise return `/bin/sh`.
 *
 * Kept synchronous on purpose. Upstream's async path only needs async
 * for the libc buffer resize loop and tokio span instrumentation;
 * filesystem-level checks are stat-only. Callers that want to await
 * can wrap this call; most bootstrap paths run it once at startup
 * outside the hot path.
 */
export function discoverDefaultUserShell(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): DiscoveredShell {
  const env = options.env ?? process.env;
  const userShellPath = getUserShellPathUnix(env);

  if (userShellPath) {
    const type = detectShellType(userShellPath);
    if (type && fileExists(userShellPath)) {
      return buildShell(userShellPath, type);
    }
  }

  for (const candidate of UNIX_FALLBACK_PATHS) {
    if (fileExists(candidate.path)) {
      return buildShell(candidate.path, candidate.type);
    }
  }

  return ultimateFallback();
}

/**
 * Async wrapper kept so bootstrap code can `await` discovery without
 * special-casing the sync path. Matches the shape of upstream's
 * `session_init.shell_discovery` future; the work itself is still
 * synchronous under the hood.
 */
export async function discoverDefaultUserShellAsync(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<DiscoveredShell> {
  return discoverDefaultUserShell(options);
}
