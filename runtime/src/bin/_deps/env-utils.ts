/**
 * Per-dir config-home resolution for `runtime/src/bin/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/envUtils.ts` helpers
 * the bootstrap path consumes:
 *   - `resolveClaudeConfigHomeDir(opts?)`
 *   - `getClaudeConfigHomeDir()`
 *
 * The bootstrap path uses these to locate transcript candidates under
 * legacy config homes for context-collapse rehydration.
 * Carved as a local `_deps/` to keep bootstrap self-contained.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolveClaudeConfigHomeDirOptions {
  readonly configDirEnv?: string;
  readonly homeDir?: string;
  readonly openClaudeExists?: boolean;
  readonly legacyClaudeExists?: boolean;
}

export function resolveClaudeConfigHomeDir(
  options?: ResolveClaudeConfigHomeDirOptions,
): string {
  if (options?.configDirEnv) {
    return options.configDirEnv.normalize("NFC");
  }

  const home = options?.homeDir ?? homedir();
  const openClaudeDir = join(home, ".openclaude");
  const legacyClaudeDir = join(home, ".claude");
  const openClaudeExists =
    options?.openClaudeExists ?? existsSync(openClaudeDir);
  const legacyClaudeExists =
    options?.legacyClaudeExists ?? existsSync(legacyClaudeDir);

  if (!openClaudeExists && legacyClaudeExists) {
    return legacyClaudeDir.normalize("NFC");
  }
  return openClaudeDir.normalize("NFC");
}

export function getClaudeConfigHomeDir(): string {
  return resolveClaudeConfigHomeDir({
    configDirEnv: process.env.CLAUDE_CONFIG_DIR,
  });
}
