/**
 * Landlock launcher access — resolve, probe, grant serialization, and outcome
 * classification for `agenc-landlock-run`, the self-restrict-then-exec
 * Landlock launcher vendored at `runtime/native/agenc-landlock-run.c`.
 *
 * Landlock is an independent kernel syscall family: it needs no user
 * namespaces, no mount privileges, and no LSM profile, which makes it the
 * natural confinement rung for hosts where bubblewrap is unusable (Ubuntu
 * 24.04+ with `apparmor_restrict_unprivileged_userns=1` and no AgenC AppArmor
 * profile installed). This module only RESOLVES and REPORTS that capability;
 * wiring it into the execution path is a separate, deliberate change.
 *
 * The binary keeps the upstream CLI contract verbatim (DeepSeek Harness
 * `landlock-run`, MIT): grants via `--ro`/`--rw`, `--probe`, fatal lines
 * prefixed `landlock-run: `, launcher failures exit 125. Classification below
 * follows the rule their postmortem 0004 arrived at after misattributing
 * child exits to the launcher: launcher failure requires BOTH the failure
 * status AND fatal-line evidence, after excluding the exact informational
 * partial-enforcement notice. A confined child can still forge that pair on
 * purpose — stderr is an in-band channel — so classification informs
 * diagnostics, never a security decision.
 *
 * @module
 */

import { spawnSync, execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LANDLOCK_RUN_NAME = "agenc-landlock-run";

/** Every launcher-level failure exits with this code; children pass through. */
export const LANDLOCK_RUN_FAILURE_EXIT = 125;

/**
 * The one informational stderr line a successful confined run may print (on
 * kernels older than the launcher's newest known ABI). Exact-match excluded
 * from fatal evidence; everything else under the prefix is fatal.
 */
export const LANDLOCK_RUN_PARTIAL_NOTICE =
  "landlock-run: partial enforcement (older Landlock ABI)";

const LANDLOCK_RUN_FATAL_PREFIX = "landlock-run: ";

const PROBE_TIMEOUT_MS = 5_000;

/** Functional enforcement level reported by `--probe`. */
export type LandlockEnforcement = "full" | "partial" | "unusable";

let compiledLandlockRun: string | undefined;

function isExecutableFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the launcher binary: a bundled sibling of this module when present,
 * otherwise compiled once per process from the in-tree source with the same
 * trusted-compiler discovery and hardened flags as the process broker
 * (fixed absolute compiler paths — never a PATH search). Returns undefined
 * when unavailable (non-Linux, missing source, or no trusted compiler);
 * callers treat that as `unusable` and fall closed.
 */
export function resolveLandlockRun(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (compiledLandlockRun !== undefined) return compiledLandlockRun;

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // The build compiles the launcher to the dist ROOT; this module may be
  // bundled into a root chunk or under dist/bin, so probe both geometries.
  const bundledCandidates = [
    join(moduleDirectory, LANDLOCK_RUN_NAME),
    resolve(moduleDirectory, "..", LANDLOCK_RUN_NAME),
  ];
  const bundled = bundledCandidates.find(isExecutableFile);
  if (bundled !== undefined) {
    compiledLandlockRun = bundled;
    return bundled;
  }

  const sourceCandidates = [
    resolve(moduleDirectory, "../../native/agenc-landlock-run.c"),
    resolve(moduleDirectory, "../native/agenc-landlock-run.c"),
  ];
  const sourcePath = sourceCandidates.find((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (sourcePath === undefined) return undefined;

  const compiler = ["/usr/bin/cc", "/bin/cc"].find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (compiler === undefined) return undefined;

  try {
    const buildRoot = mkdtempSync(join(tmpdir(), "agenc-landlock-run-"));
    chmodSync(buildRoot, 0o700);
    const outputPath = join(buildRoot, LANDLOCK_RUN_NAME);
    execFileSync(
      compiler,
      [
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-D_FORTIFY_SOURCE=2",
        "-fstack-protector-strong",
        "-Wl,-z,relro,-z,now",
        "-o",
        outputPath,
        sourcePath,
      ],
      {
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: "pipe",
      },
    );
    compiledLandlockRun = outputPath;
    return outputPath;
  } catch {
    return undefined;
  }
}

/**
 * Functional enforcement probe. `--probe` builds and enforces a maximal
 * ruleset in a short-lived process — a version check would miss a kernel
 * that has the syscalls but refuses enforcement, so actually restricting is
 * the only honest signal. Unresolvable launcher, non-zero exit, timeout, or
 * an unrecognized report line all map to `unusable` (fail closed).
 */
export function probeLandlock(launcherPath?: string): LandlockEnforcement {
  const launcher = launcherPath ?? resolveLandlockRun();
  if (launcher === undefined) return "unusable";
  const result = spawnSync(launcher, ["--probe"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    windowsHide: true,
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    return "unusable";
  }
  const line = (result.stdout ?? "").trim();
  if (line === "landlock: fully enforced") return "full";
  if (line === "landlock: partially enforced (older ABI)") return "partial";
  return "unusable";
}

/** Grant argv for one confined run; everything not granted is denied. */
export function landlockGrantArgs(grants: {
  readonly readOnly?: readonly string[];
  readonly readWrite?: readonly string[];
}): string[] {
  const args: string[] = [];
  for (const path of grants.readOnly ?? []) args.push("--ro", path);
  for (const path of grants.readWrite ?? []) args.push("--rw", path);
  return args;
}

export type LandlockRunOutcome =
  | { readonly kind: "launcher-failure"; readonly fatalLine: string }
  | { readonly kind: "command-outcome" };

/**
 * Attribute one finished confined run to the launcher or to the wrapped
 * command. Launcher failure requires the conjunction the CLI contract
 * guarantees: exit status 125 AND at least one `landlock-run: ` stderr line
 * that is not the exact partial-enforcement notice. Anything else — including
 * a child that itself exits 125, or the notice followed by an ordinary
 * non-zero child exit — is the command's own outcome. This is the
 * status-gated rule from upstream postmortem 0004, where the notice plus
 * ripgrep's no-match exit 1 was misread as sandbox failure.
 */
export function classifyLandlockRunOutcome(run: {
  readonly status: number | null;
  readonly stderr: string;
}): LandlockRunOutcome {
  if (run.status !== LANDLOCK_RUN_FAILURE_EXIT) return { kind: "command-outcome" };
  const fatalLine = run.stderr
    .split(/\r?\n/)
    .find(
      (line) =>
        line.startsWith(LANDLOCK_RUN_FATAL_PREFIX) &&
        line.trim() !== LANDLOCK_RUN_PARTIAL_NOTICE,
    );
  if (fatalLine === undefined) return { kind: "command-outcome" };
  return { kind: "launcher-failure", fatalLine };
}
