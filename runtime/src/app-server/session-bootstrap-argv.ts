import {
  validateAndDedupeAdditionalWorkingDirectoryInputs,
} from "../contracts/additional-working-directories.js";

export interface StructuredSessionBootstrapSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
}

/**
 * Build a session bootstrap argv from one structured authority.
 *
 * Only the executable and entrypoint coordinates are inherited. Daemon launch
 * flags are process configuration, not child-session configuration, and must
 * never suppress a run's frozen provider, model, profile, or permission mode.
 */
export function buildStructuredSessionBootstrapArgv(
  selection: StructuredSessionBootstrapSelection,
  executableArgv: readonly string[],
): readonly string[] {
  const executable = executableArgv[0]?.trim();
  const entrypoint = executableArgv[1]?.trim();
  if (!executable || !entrypoint) {
    throw new TypeError(
      "session bootstrap requires explicit executable and entrypoint argv",
    );
  }

  const argv = [executable, entrypoint];
  appendFlag(argv, "--provider", selection.provider);
  appendFlag(argv, "--model", selection.model);
  appendFlag(argv, "--profile", selection.profile);
  appendFlag(argv, "--config", selection.configPath);
  const addDirs = validateAndDedupeAdditionalWorkingDirectoryInputs(
    selection.addDirs ?? [],
    "session bootstrap addDirs",
  );
  for (const addDir of addDirs) {
    argv.push(`--add-dir=${addDir}`);
  }
  if (selection.permissionMode !== undefined) {
    argv.push("--permission-mode", selection.permissionMode);
  }
  return argv;
}

function appendFlag(
  argv: string[],
  flag: string,
  value: string | undefined,
): void {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return;
  argv.push(flag, trimmed);
}
