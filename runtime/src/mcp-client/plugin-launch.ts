import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import type { MCPServerConfig } from "./types.js";
import { createStdioMCPEnvironment } from "./transports/stdio-environment.js";

type Launch = Pick<MCPServerConfig, "command" | "args" | "cwd" | "env" | "env_vars">;

function normalized(value: string, platform: NodeJS.Platform): string {
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  const slashed = decoded.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

function mentionsRoot(value: string, root: string, platform: NodeJS.Platform): boolean {
  const haystack = normalized(value, platform);
  const needle = normalized(root, platform);
  if (!needle) return false;
  const paths = platform === "win32" ? win32 : posix;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (before !== undefined && /[a-z0-9._-]/i.test(before)) continue;
    if (after !== undefined && /[a-z0-9._-]/i.test(after)) continue;
    const suffix = haystack.slice(at + needle.length).split(/[\s"'<>|;,()=?:]/, 1)[0] ?? "";
    const candidate = paths.normalize(needle + suffix).replace(/\\/g, "/").replace(/\/+$/, "");
    if (candidate === needle || candidate.startsWith(`${needle}/`)) return true;
  }
  return false;
}

function realPathWithMissingTail(value: string, platform: NodeJS.Platform): string | undefined {
  // Realpath the longest existing prefix so a link to the installation also
  // catches a yet-to-be-created child beneath that link.
  const paths = platform === "win32" ? win32 : posix;
  let prefix = value;
  const tail: string[] = [];
  for (;;) {
    try { return paths.join(realpathSync.native(prefix), ...tail.reverse()); }
    catch { /* Try the parent. */ }
    const parent = paths.dirname(prefix);
    if (parent === prefix) return undefined;
    tail.push(paths.basename(prefix));
    prefix = parent;
  }
}

function pointsIntoRoot(value: string, root: string, platform: NodeJS.Platform): boolean {
  if (mentionsRoot(value, root, platform)) return true;
  const realRoot = realPathWithMissingTail(root, platform);
  if (!realRoot) return false;
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  const paths = platform === "win32" ? win32 : posix;
  const pathListSeparator = platform === "win32" ? ";" : ":";
  const directPaths = [decoded, ...decoded.split(pathListSeparator),
    ...Array.from(decoded.matchAll(/(?:^|[=,"'])((?:[a-zA-Z]:[\\/]|\/)[^"']+)/g), match => match[1]!)];
  for (const candidate of directPaths) {
    if (!paths.isAbsolute(candidate)) continue;
    const resolved = realPathWithMissingTail(candidate, platform);
    if (resolved && mentionsRoot(resolved, realRoot, platform)) return true;
  }
  for (const match of value.matchAll(/file:\/\/[^\s"'<>|;,()]+/gi)) {
    try {
      const url = new URL(match[0]);
      const candidate = platform === "win32"
        ? decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1")
        : fileURLToPath(url);
      const resolved = realPathWithMissingTail(candidate, platform);
      if (resolved && mentionsRoot(resolved, realRoot, platform)) return true;
    } catch { /* Other argument text is not a file URL. */ }
  }
  const pathPattern = platform === "win32"
    ? /[a-zA-Z]:[\\/][^\s"'<>|;,()=:?]+/g
    : /\/+[^\s"'<>|;,()=:?]+/g;
  for (const match of decoded.matchAll(pathPattern)) {
    const candidate = match[0].replace(/[.]+$/, "");
    const resolved = realPathWithMissingTail(candidate, platform);
    if (resolved && mentionsRoot(resolved, realRoot, platform)) return true;
  }
  return false;
}

function executableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

function resolvedExecutable(command: string, env: Readonly<Record<string, string>>, cwd: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  if (paths.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return paths.resolve(cwd, command);
  }
  const search = platform === "win32"
    ? [cwd, ...(env.PATH ?? "").split(";")]
    : (env.PATH ?? "/usr/bin:/bin").split(":");
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const names = platform === "win32" && !extensions.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()))
    ? [command, ...extensions.map(ext => `${command}${ext}`)] : [command];
  for (const directory of search) {
    for (const name of names) {
      const candidate = paths.resolve(cwd, directory || ".", name);
      if (executableFile(candidate, platform)) return candidate;
    }
  }
  return command;
}

/** Validate the same fields and filtered environment the stdio child receives. */
export function assertPluginSnapshotLaunchSafe(
  serverName: string,
  pluginRoot: string,
  launch: Launch,
  parentEnvironment: ProviderEnvironment,
  platform: NodeJS.Platform = process.platform,
  baseCwd: string = process.cwd(),
): void {
  const env = createStdioMCPEnvironment(launch.env, launch.env_vars, parentEnvironment);
  const paths = platform === "win32" ? win32 : posix;
  const cwd = paths.resolve(baseCwd, launch.cwd ?? ".");
  const command = launch.command ?? "";
  const values = [command, resolvedExecutable(command, env, cwd, platform), cwd,
    ...(launch.args ?? []), ...Object.values(env)];
  if (values.some(value => pointsIntoRoot(value, pluginRoot, platform))) {
    throw new Error(`MCP plugin ${serverName} launch references its mutable installation`);
  }
}
