/** Parse literal startup flags without loading model or settings authorities. */
import {
  isUserAddressablePermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from "../permissions/types.js";
import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { extractFlagValue, extractFlagValues } from "./route.js";
import {
  assertNoRetiredStartupFlags,
  AUTONOMOUS_FLAG,
  BYPASS_APPROVALS_FLAG,
  DANGEROUS_BYPASS_FLAG,
} from "./startup-flags.js";
import { validateAndDedupeAdditionalWorkingDirectoryInputs } from "../contracts/additional-working-directories.js";

export interface StartupCliFlags {
  readonly taskTokenBudget?: number;
  readonly taskMaxCalls?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
  /**
   * `--bypass-approvals`: approvals off, sandbox kept. Also sets
   * `permissionMode` to `bypassPermissions` so every consumer of the startup
   * mode sees the same thing `--permission-mode bypassPermissions` would give.
   */
  readonly bypassApprovals?: boolean;
  readonly autonomousMode?: boolean;
  readonly simpleMode?: boolean;
  readonly lightMode?: boolean;
  readonly fullDurability?: boolean;
}

export function readStartupCliFlags(
  argv: readonly string[],
): StartupCliFlags {
  const userArgv = argv.slice(2);
  const { optionArgs } = tokenizeCliOptionRegion(userArgv);
  assertNoRetiredStartupFlags(optionArgs);
  const taskBudgetFlag = (flag: string): number | undefined => {
    const present = optionArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (!present) return undefined;
    const raw = extractFlagValue(optionArgs, flag);
    const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${flag} requires a non-negative safe integer (0 disables the limit)`);
    }
    return value;
  };
  const taskTokenBudget = taskBudgetFlag("--task-token-budget");
  const taskMaxCalls = taskBudgetFlag("--task-max-calls");
  const provider = extractFlagValue(optionArgs, "--provider") ?? undefined;
  const model = extractFlagValue(optionArgs, "--model") ?? undefined;
  const profile = extractFlagValue(optionArgs, "--profile") ?? undefined;
  const configPath = extractFlagValue(optionArgs, "--config") ?? undefined;
  const addDirs = validateAndDedupeAdditionalWorkingDirectoryInputs(
    extractFlagValues(optionArgs, "--add-dir"),
    "agenc --add-dir",
  );
  const rawPermissionMode =
    extractFlagValue(optionArgs, "--permission-mode") ?? undefined;
  // Distinguish "flag absent" from "flag present but invalid". An invalid
  // value must not be silently coerced to `undefined` (which would boot in
  // DEFAULT mode — a silent failure toward a LESS restrictive session). Throw
  // a helpful error mirroring provider validation and `/permissions mode`,
  // surfacing as a clean error + non-zero exit at the CLI entrypoint.
  const explicitPermissionMode = resolvePermissionModeOrThrow(rawPermissionMode);
  const dangerouslyBypassApprovalsAndSandbox =
    optionArgs.includes(DANGEROUS_BYPASS_FLAG);
  const bypassApprovals = optionArgs.includes(BYPASS_APPROVALS_FLAG);
  // `--bypass-approvals` is the approvals-only half of the dangerous flag. It
  // resolves to the bypassPermissions mode; a different explicit
  // `--permission-mode` alongside it is a contradiction, not a tie to break
  // silently toward a less restrictive session.
  if (
    bypassApprovals &&
    explicitPermissionMode !== undefined &&
    explicitPermissionMode !== "bypassPermissions"
  ) {
    throw new Error(
      `${BYPASS_APPROVALS_FLAG} conflicts with --permission-mode ${explicitPermissionMode}. Pass one of them.`,
    );
  }
  const permissionMode = bypassApprovals
    ? ("bypassPermissions" as const)
    : explicitPermissionMode;
  const autonomousMode = optionArgs.includes(AUTONOMOUS_FLAG);
  const simpleMode = optionArgs.includes("--bare");
  const lightMode = optionArgs.includes("--light");
  return Object.freeze({
    ...(taskTokenBudget !== undefined ? { taskTokenBudget } : {}),
    ...(taskMaxCalls !== undefined ? { taskMaxCalls } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
    ...(configPath ? { configPath } : {}),
    ...(addDirs.length > 0 ? { addDirs: Object.freeze(addDirs) } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(dangerouslyBypassApprovalsAndSandbox
      ? { dangerouslyBypassApprovalsAndSandbox: true }
      : {}),
    ...(bypassApprovals ? { bypassApprovals: true } : {}),
    ...(autonomousMode ? { autonomousMode: true } : {}),
    ...(simpleMode ? { simpleMode: true } : {}),
    ...(lightMode ? { lightMode: true } : {}),
    ...(optionArgs.includes("--full-durability") ? { fullDurability: true } : {}),
  });
}

function resolvePermissionModeOrThrow(
  raw: string | undefined,
): PermissionMode | undefined {
  // Flag absent (or explicitly empty) — keep the default-mode behavior.
  if (!raw) return undefined;
  // A user-addressable mode — honor it.
  if (isUserAddressablePermissionMode(raw)) return raw;
  // Internal modes and typos are both invalid at the user-facing CLI. Never
  // recognize a value and then silently discard it: that would boot with a
  // different permission mode than the operator requested.
  throw new Error(
    `unknown permission mode '${raw}'. Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
  );
}
