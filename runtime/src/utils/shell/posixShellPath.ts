import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type SupportedPosixShell = "bash" | "zsh";

export function supportedPosixShellKind(
  shellPath: string,
): SupportedPosixShell | undefined {
  switch (basename(shellPath).toLocaleLowerCase("en-US")) {
    case "bash":
    case "bash.exe":
      return "bash";
    case "zsh":
    case "zsh.exe":
      return "zsh";
    default:
      return undefined;
  }
}

/** Whether an explicit shell path names one of the parsers AgenC supports. */
export function isSupportedPosixShellPath(shellPath: string): boolean {
  return supportedPosixShellKind(shellPath) !== undefined;
}

export type PosixShellProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * How long a shell gets to say what it is.
 *
 * A second is generous for a native shell and far too little for Git Bash on
 * Windows, where starting one goes through msys2's process emulation: a plain
 * `echo` measured 2,045 ms on an ordinary Windows 11 machine with Git for
 * Windows installed. The probe timed out and AgenC reported no suitable shell
 * on a machine that had one, with no way for the reader to tell the difference
 * from not having installed Git at all. Windows therefore gets a bound wide
 * enough for a slow start and still narrow enough to fail fast on a shell that
 * has genuinely hung.
 */
const PROBE_TIMEOUT_MS = process.platform === "win32" ? 10_000 : 1_000;

function describeProbeFailure(error: unknown): string {
  const failure = error as NodeJS.ErrnoException & {
    status?: number | null;
    signal?: string | null;
    stderr?: string | Buffer;
  };
  if (failure.code === "ENOENT") return "not found";
  if (failure.code === "EACCES" || failure.code === "EPERM") return "not executable";
  if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM") {
    return `did not answer within ${PROBE_TIMEOUT_MS} ms`;
  }
  const stderr = String(failure.stderr ?? "").trim().split("\n")[0]?.slice(0, 120);
  if (typeof failure.status === "number") {
    return `exited with code ${failure.status}${stderr ? ` (${stderr})` : ""}`;
  }
  return failure.message?.split("\n")[0]?.slice(0, 160) ?? String(error);
}

/**
 * Run a candidate shell and ask it to identify itself, so that a probe failure
 * carries the reason (missing, not executable, hung, crashed) instead of a
 * bare false. The reason is meant for the "no suitable shell" error.
 */
export function probePosixShellPath(
  shellPath: string,
  childEnvironment: Readonly<NodeJS.ProcessEnv>,
): PosixShellProbe {
  try {
    const marker = "__agenc_supported_posix_shell__";
    const output = execFileSync(
      shellPath,
      [
        "-c",
        `if [ -n "$BASH_VERSION" ] || [ -n "$ZSH_VERSION" ]; then printf %s ${marker}; else exit 1; fi`,
      ],
      {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output === marker
      ? { ok: true }
      : { ok: false, reason: `did not identify as bash or zsh (${JSON.stringify(output.slice(0, 40))})` };
  } catch (error) {
    return { ok: false, reason: describeProbeFailure(error) };
  }
}

/** Verify that a selected shell path can actually be executed. */
export function isExecutableShellPath(
  shellPath: string,
  childEnvironment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  return probePosixShellPath(shellPath, childEnvironment).ok;
}
