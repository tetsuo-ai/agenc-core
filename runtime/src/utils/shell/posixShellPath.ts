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

/** Verify that a selected shell path can actually be executed. */
export function isExecutableShellPath(
  shellPath: string,
  childEnvironment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  try {
    const marker = "__agenc_supported_posix_shell__";
    const output = execFileSync(
      shellPath,
      [
        "-c",
        `if [ -n "$BASH_VERSION" ] || [ -n "$ZSH_VERSION" ]; then printf %s ${marker}; else exit 1; fi`,
      ],
      {
        timeout: 1_000,
        encoding: "utf8",
        env: childEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output === marker;
  } catch {
    return false;
  }
}
