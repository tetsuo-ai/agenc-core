import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
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

/** Verify that a selected shell path can actually be executed. */
export function isExecutableShellPath(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK);
    return true;
  } catch {
    // Some Nix-style environments can execute a shell even when access(X_OK)
    // does not describe the final interpreter chain accurately.
    try {
      execFileSync(shellPath, ["--version"], {
        timeout: 1_000,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }
}
