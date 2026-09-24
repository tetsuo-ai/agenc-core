/**
 * A snapshot pins launch paths described by plugin manifest fields: command,
 * args, cwd, env, requested env_vars, templates, and relative paths. This is
 * not a sandbox; plugin code may deliberately read the installed copy at run
 * time under the user's permissions. Plugin trust covers that code.
 */
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import type { MCPServerConfig } from "./types.js";
import { createStdioMCPEnvironment } from "./transports/stdio-environment.js";
import { resolveStdioProgram } from "./transports/stdio-program.js";

type Launch = Pick<MCPServerConfig, "command" | "args" | "cwd" | "env" | "env_vars">;

function normalized(value: string, platform: NodeJS.Platform): string {
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  const paths = platform === "win32" ? win32 : posix;
  const slashed = paths.normalize(decoded).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

function insideRoot(value: string, root: string, platform: NodeJS.Platform): boolean {
  const candidate = normalized(value, platform);
  const needle = normalized(root, platform);
  return !!needle && (candidate === needle || candidate.startsWith(`${needle}/`));
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

function pointsIntoRoot(value: string, root: string, platform: NodeJS.Platform, cwd: string): boolean {
  const realRoot = realPathWithMissingTail(root, platform);
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  const paths = platform === "win32" ? win32 : posix;
  const pathListSeparator = platform === "win32" ? ";" : ":";
  const isDirectPath = paths.isAbsolute(decoded);
  const optionPath = /^[^\s=]+=((?:[a-zA-Z]:[\\/]|\/).*)$/.exec(decoded)?.[1];
  const candidates = [decoded, ...decoded.split(pathListSeparator)];
  const directPaths = isDirectPath || optionPath ? [...candidates, ...(optionPath ? [optionPath] : [])] : [
    ...candidates,
    ...Array.from(decoded.matchAll(/(?:^|[=,"'])((?:[a-zA-Z]:[\\/]|\/)[^"']+)/g), match => match[1]!),
  ];
  for (const candidate of directPaths) {
    if (!paths.isAbsolute(candidate)) continue;
    if (insideRoot(candidate, root, platform)) return true;
    const resolved = realPathWithMissingTail(candidate, platform);
    if (realRoot && resolved && insideRoot(resolved, realRoot, platform)) return true;
  }
  for (const match of value.matchAll(/file:\/\/[^"'<>|;,()]+/gi)) {
    try {
      const url = new URL(match[0].trim());
      const candidate = platform === "win32"
        ? decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1")
        : fileURLToPath(url);
      if (insideRoot(candidate, root, platform)) return true;
      const resolved = realPathWithMissingTail(candidate, platform);
      if (realRoot && resolved && insideRoot(resolved, realRoot, platform)) return true;
    } catch { /* Other argument text is not a file URL. */ }
  }
  // Embedded absolute operands in options and simple command strings. A whole
  // absolute argument may contain spaces, so do not split it into shell words.
  if (isDirectPath || optionPath || /^(?:--?[\w-]+=)?file:\/\//i.test(decoded)) return false;
  const pathPattern = platform === "win32"
    ? /[a-zA-Z]:[\\/][^\s"'<>|;,()=:?]+/g
    : /\/+[^\s"'<>|;,()=:?]+/g;
  for (const match of decoded.matchAll(pathPattern)) {
    const candidate = match[0].replace(/[.]+$/, "");
    if (insideRoot(candidate, root, platform)) return true;
    const resolved = realPathWithMissingTail(candidate, platform);
    if (realRoot && resolved && insideRoot(resolved, realRoot, platform)) return true;
  }
  // Relative operands are interpreted from the child cwd. Ignore opaque shell
  // expressions; the manifest can only pin paths it describes as operands.
  for (const item of candidates) {
    const operand = item.startsWith("--") && item.includes("=") ? item.slice(item.indexOf("=") + 1) : item;
    if (!operand || operand.includes("://") || /["'<>|;,()]/.test(operand)) continue;
    if (paths.isAbsolute(operand) || operand.startsWith("-")) continue;
    const resolved = paths.resolve(cwd, operand);
    if (insideRoot(resolved, root, platform)) return true;
    const real = realPathWithMissingTail(resolved, platform);
    if (realRoot && real && insideRoot(real, realRoot, platform)) return true;
  }
  return false;
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
  const values = [command, resolveStdioProgram(command, env, cwd, platform), cwd,
    ...(launch.args ?? []), ...Object.values(env)];
  if (values.some(value => pointsIntoRoot(value, pluginRoot, platform, cwd))) {
    throw new Error(`MCP plugin ${serverName} launch references its mutable installation`);
  }
}
