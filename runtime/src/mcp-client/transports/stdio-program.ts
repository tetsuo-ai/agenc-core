import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

function executableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve the program passed to the stdio spawn and checked before plugin launch. */
export function resolveStdioProgram(
  command: string,
  env: Readonly<Record<string, string>>,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  isExecutable: (candidate: string) => boolean = candidate => executableFile(candidate, platform),
): string {
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return paths.resolve(cwd, command);
  }

  const search = platform === "win32"
    ? [cwd, ...(env.PATH ?? "").split(";")]
    : (env.PATH ?? "/usr/bin:/bin").split(":");
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(ext => ext.trim()).filter(Boolean)
    : [];
  const hasExtension = extensions.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()));
  const names = platform === "win32" && !hasExtension
    ? [command, ...extensions.map(ext => `${command}${ext}`)] : [command];
  for (const directory of search) {
    for (const name of names) {
      const candidate = paths.resolve(cwd, directory || ".", name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return command;
}
