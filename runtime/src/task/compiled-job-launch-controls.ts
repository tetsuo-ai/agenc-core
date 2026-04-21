export interface CompiledJobLaunchControls {
  readonly executionEnabled: boolean;
  readonly paused: boolean;
  readonly enabledJobTypes: readonly string[];
  readonly disabledJobTypes: readonly string[];
}

export type CompiledJobLaunchDenyReason =
  | "unsupported_job_type"
  | "launch_execution_disabled"
  | "launch_paused"
  | "launch_job_type_not_enabled"
  | "launch_job_type_disabled";

export interface ResolveCompiledJobLaunchControlsOptions {
  readonly base?: Partial<CompiledJobLaunchControls>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CompiledJobLaunchDecision {
  readonly allowed: boolean;
  readonly reason?: CompiledJobLaunchDenyReason;
  readonly message?: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveCompiledJobLaunchControls(
  options: ResolveCompiledJobLaunchControlsOptions = {},
): CompiledJobLaunchControls {
  const envControls = readCompiledJobLaunchControlsFromEnv(options.env);
  const base = options.base ?? {};
  return {
    executionEnabled:
      base.executionEnabled ?? envControls.executionEnabled ?? true,
    paused: base.paused ?? envControls.paused ?? false,
    enabledJobTypes: normalizeJobTypeList(
      base.enabledJobTypes ?? envControls.enabledJobTypes,
    ),
    disabledJobTypes: normalizeJobTypeList(
      base.disabledJobTypes ?? envControls.disabledJobTypes,
    ),
  };
}

export function evaluateCompiledJobLaunchAccess(input: {
  readonly jobType: string;
  readonly supportedJobTypes: readonly string[];
  readonly controls: CompiledJobLaunchControls;
}): CompiledJobLaunchDecision {
  if (!input.supportedJobTypes.includes(input.jobType)) {
    return {
      allowed: false,
      reason: "unsupported_job_type",
      message: `Compiled job type "${input.jobType}" is not enabled for this task handler`,
    };
  }
  if (!input.controls.executionEnabled) {
    return {
      allowed: false,
      reason: "launch_execution_disabled",
      message:
        "Compiled marketplace job execution is disabled by runtime launch controls",
    };
  }
  if (input.controls.paused) {
    return {
      allowed: false,
      reason: "launch_paused",
      message:
        "Compiled marketplace job execution is paused by runtime launch controls",
    };
  }
  if (
    input.controls.enabledJobTypes.length > 0 &&
    !input.controls.enabledJobTypes.includes(input.jobType)
  ) {
    return {
      allowed: false,
      reason: "launch_job_type_not_enabled",
      message: `Compiled job type "${input.jobType}" is not enabled in runtime launch controls`,
    };
  }
  if (input.controls.disabledJobTypes.includes(input.jobType)) {
    return {
      allowed: false,
      reason: "launch_job_type_disabled",
      message: `Compiled job type "${input.jobType}" is disabled by runtime launch controls`,
    };
  }
  return { allowed: true };
}

function readCompiledJobLaunchControlsFromEnv(
  env: NodeJS.ProcessEnv | undefined,
): Partial<CompiledJobLaunchControls> {
  if (!env) {
    return {};
  }
  return {
    ...(parseBooleanEnv(env.AGENC_COMPILED_JOB_EXECUTION_ENABLED) !== undefined
      ? {
          executionEnabled: parseBooleanEnv(
            env.AGENC_COMPILED_JOB_EXECUTION_ENABLED,
          ),
        }
      : {}),
    ...(parseBooleanEnv(env.AGENC_COMPILED_JOB_EXECUTION_PAUSED) !== undefined
      ? {
          paused: parseBooleanEnv(env.AGENC_COMPILED_JOB_EXECUTION_PAUSED),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_ENABLED_TYPES !== undefined
      ? {
          enabledJobTypes: normalizeJobTypeList(
            env.AGENC_COMPILED_JOB_ENABLED_TYPES,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_DISABLED_TYPES !== undefined
      ? {
          disabledJobTypes: normalizeJobTypeList(
            env.AGENC_COMPILED_JOB_DISABLED_TYPES,
          ),
        }
      : {}),
  };
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function normalizeJobTypeList(
  value: readonly string[] | string | undefined,
): string[] {
  if (Array.isArray(value)) {
    return uniqueNonEmptyStrings(value);
  }
  if (typeof value === "string") {
    return uniqueNonEmptyStrings(value.split(","));
  }
  return [];
}

function uniqueNonEmptyStrings(input: readonly string[]): string[] {
  return [...new Set(input.map((entry) => entry.trim()).filter(Boolean))];
}
