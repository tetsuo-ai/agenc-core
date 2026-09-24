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
import { resolveSpawnExecutable } from "../sandbox/execution-broker.js";
import type { MCPServerConfig } from "./types.js";
import { createStdioMCPEnvironment } from "./transports/stdio-environment.js";

type Launch = Pick<MCPServerConfig, "command" | "args" | "cwd" | "env" | "env_vars">;

function normalized(value: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  const slashed = paths.normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
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
  const paths = platform === "win32" ? win32 : posix;
  const pathListSeparator = platform === "win32" ? ";" : ":";
  const candidates = [value];
  const equals = value.indexOf("=");
  if (equals !== -1) candidates.push(value.slice(equals + 1));
  for (const candidate of [...candidates]) {
    if (!candidate.includes("://") && candidate.includes(pathListSeparator)) {
      candidates.push(...candidate.split(pathListSeparator));
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const targets = [candidate];
    if (candidate.toLowerCase().startsWith("file:")) {
      try { targets.push(fileURLToPath(new URL(candidate), { windows: platform === "win32" })); }
      catch { /* The entire literal is still a path candidate. */ }
    }
    for (const target of targets) {
      const resolved = paths.resolve(cwd, target);
      if (insideRoot(resolved, root, platform)) return true;
      const real = realPathWithMissingTail(resolved, platform);
      if (realRoot && real && insideRoot(real, realRoot, platform)) return true;
    }
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
  // The broker performs the final executable search immediately before spawn.
  // A missing executable is still reported by that broker; keep checking the
  // other literal launch fields here so they cannot hide a mutable path.
  let executable: string | undefined;
  try { executable = resolveSpawnExecutable({ program: command, cwd, env, platform }); }
  catch { /* The broker will report an unavailable executable at launch. */ }
  const values = [command, cwd, ...(executable === undefined ? [] : [executable]),
    ...(launch.args ?? []), ...Object.values(env)];
  if (values.some(value => pointsIntoRoot(value, pluginRoot, platform, cwd))) {
    throw new Error(`MCP plugin ${serverName} launch references its mutable installation`);
  }
}
