import { basename } from "node:path";
import { formatShellWrapperCommand } from "../bash/shellPrefix.js";

type CommandShellKind = "cmd" | "powershell" | "posix";

function commandShellKind(shellPath: string): CommandShellKind {
  const name = basename(shellPath.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (name === "cmd") return "cmd";
  if (name === "powershell" || name === "pwsh") return "powershell";
  return "posix";
}

/** Whether a shell accepts the POSIX wrapper configured at session ingress. */
export function acceptsPosixCommandWrapper(shellPath: string): boolean {
  return commandShellKind(shellPath) === "posix";
}

/** Apply the captured POSIX wrapper only when the selected shell accepts it. */
export function wrapCommandForShell(
  shellPath: string,
  commandWrapperArgv: readonly string[] | undefined,
  command: string,
): string {
  return acceptsPosixCommandWrapper(shellPath) &&
    (commandWrapperArgv?.length ?? 0) > 0
    ? formatShellWrapperCommand(commandWrapperArgv!, command)
    : command;
}

/** Build argv for an explicitly selected command shell, independent of host OS. */
export function commandShellArgs(
  shellPath: string,
  command: string,
  login: boolean = false,
): readonly string[] {
  switch (commandShellKind(shellPath)) {
    case "cmd":
      return ["/d", "/s", "/c", command];
    case "powershell":
      return [
        ...(login ? [] : ["-NoProfile"]),
        "-NonInteractive",
        "-Command",
        command,
      ];
    case "posix":
      return [login ? "-lc" : "-c", command];
  }
}
