/** Shared startup cwd resolution; no session or RPC implementation dependency. */
import { isAbsolute, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { resolveWorkspace as resolveWorkspaceFromEnv } from "../config/workspace-environment.js";
import { formatUnavailableCliCwdMessage } from "./cli-process-main.js";

export function readProcessCwdSafely(cwdFn: () => string = processCwd): string | null {
  try {
    return cwdFn();
  } catch {
    return null;
  }
}

export function resolveCliCwdForStartup(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly useEnvWorkspace?: boolean;
    readonly cwdFn?: () => string;
  } = {},
):
  | { readonly ok: true; readonly cwd: string }
  | { readonly ok: false; readonly message: string } {
  if (options.useEnvWorkspace !== false) {
    const workspace = resolveWorkspaceFromEnv(env);
    if (workspace !== undefined) {
      if (isAbsolute(workspace)) {
        return { ok: true, cwd: resolve(workspace) };
      }
      const baseCwd = readProcessCwdSafely(options.cwdFn);
      if (baseCwd === null) {
        return {
          ok: false,
          message:
            "AGENC_WORKSPACE must be absolute when the current working directory is unavailable.",
        };
      }
      return { ok: true, cwd: resolve(baseCwd, workspace) };
    }
  }
  const cwd = readProcessCwdSafely(options.cwdFn);
  if (cwd === null) {
    return { ok: false, message: formatUnavailableCliCwdMessage() };
  }
  return { ok: true, cwd: resolve(cwd) };
}


export function writeUnavailableCliCwd(): number {
  process.stderr.write(`agenc: ${formatUnavailableCliCwdMessage()}\n`);
  return 1;
}

