/**
 * Per-dir config-home resolution for `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/envUtils.ts` helpers
 * the bootstrap path consumes:
 *   - `resolveAgenCConfigHomeDir(opts?)`
 *   - `getAgenCConfigHomeDir()`
 *
 * The bootstrap path uses these to locate transcript candidates under
 * AgenC config homes for context-collapse rehydration.
 * Carved as a local `_deps/` to keep bootstrap self-contained.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolveAgenCConfigHomeDirOptions {
  readonly configDirEnv?: string;
  readonly agencHomeEnv?: string;
  readonly homeDir?: string;
}

export function resolveAgenCConfigHomeDir(
  options?: ResolveAgenCConfigHomeDirOptions,
): string {
  if (options?.configDirEnv) {
    return options.configDirEnv.normalize("NFC");
  }
  if (options?.agencHomeEnv) {
    return options.agencHomeEnv.normalize("NFC");
  }

  const home = options?.homeDir ?? homedir();
  return join(home, ".agenc").normalize("NFC");
}

export function getAgenCConfigHomeDir(): string {
  return resolveAgenCConfigHomeDir({
    configDirEnv: process.env.AGENC_CONFIG_DIR,
    agencHomeEnv: process.env.AGENC_HOME,
  });
}
