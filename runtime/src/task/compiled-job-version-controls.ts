export interface CompiledJobVersionControls {
  readonly enabledCompilerVersions: readonly string[];
  readonly disabledCompilerVersions: readonly string[];
  readonly enabledPolicyVersions: readonly string[];
  readonly disabledPolicyVersions: readonly string[];
}

export type CompiledJobVersionDenyReason =
  | "compiler_version_not_enabled"
  | "compiler_version_disabled"
  | "policy_version_not_enabled"
  | "policy_version_disabled";

export interface ResolveCompiledJobVersionControlsOptions {
  readonly base?: Partial<CompiledJobVersionControls>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CompiledJobVersionDecision {
  readonly allowed: boolean;
  readonly reason?: CompiledJobVersionDenyReason;
  readonly message?: string;
}

export function resolveCompiledJobVersionControls(
  options: ResolveCompiledJobVersionControlsOptions = {},
): CompiledJobVersionControls {
  const envControls = readCompiledJobVersionControlsFromEnv(options.env);
  const base = options.base ?? {};
  return {
    enabledCompilerVersions: normalizeStringList(
      base.enabledCompilerVersions ?? envControls.enabledCompilerVersions,
    ),
    disabledCompilerVersions: normalizeStringList(
      base.disabledCompilerVersions ?? envControls.disabledCompilerVersions,
    ),
    enabledPolicyVersions: normalizeStringList(
      base.enabledPolicyVersions ?? envControls.enabledPolicyVersions,
    ),
    disabledPolicyVersions: normalizeStringList(
      base.disabledPolicyVersions ?? envControls.disabledPolicyVersions,
    ),
  };
}

export function evaluateCompiledJobVersionAccess(input: {
  readonly compilerVersion: string;
  readonly policyVersion: string;
  readonly controls: CompiledJobVersionControls;
}): CompiledJobVersionDecision {
  if (
    input.controls.enabledCompilerVersions.length > 0 &&
    !input.controls.enabledCompilerVersions.includes(input.compilerVersion)
  ) {
    return {
      allowed: false,
      reason: "compiler_version_not_enabled",
      message:
        `Compiled job compiler version "${input.compilerVersion}" ` +
        "is not enabled in runtime version controls",
    };
  }
  if (input.controls.disabledCompilerVersions.includes(input.compilerVersion)) {
    return {
      allowed: false,
      reason: "compiler_version_disabled",
      message:
        `Compiled job compiler version "${input.compilerVersion}" ` +
        "is disabled by runtime version controls",
    };
  }
  if (
    input.controls.enabledPolicyVersions.length > 0 &&
    !input.controls.enabledPolicyVersions.includes(input.policyVersion)
  ) {
    return {
      allowed: false,
      reason: "policy_version_not_enabled",
      message:
        `Compiled job policy version "${input.policyVersion}" ` +
        "is not enabled in runtime version controls",
    };
  }
  if (input.controls.disabledPolicyVersions.includes(input.policyVersion)) {
    return {
      allowed: false,
      reason: "policy_version_disabled",
      message:
        `Compiled job policy version "${input.policyVersion}" ` +
        "is disabled by runtime version controls",
    };
  }
  return { allowed: true };
}

function readCompiledJobVersionControlsFromEnv(
  env: NodeJS.ProcessEnv | undefined,
): Partial<CompiledJobVersionControls> {
  if (!env) return {};
  return {
    ...(env.AGENC_COMPILED_JOB_ENABLED_COMPILER_VERSIONS !== undefined
      ? {
          enabledCompilerVersions: normalizeStringList(
            env.AGENC_COMPILED_JOB_ENABLED_COMPILER_VERSIONS,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_DISABLED_COMPILER_VERSIONS !== undefined
      ? {
          disabledCompilerVersions: normalizeStringList(
            env.AGENC_COMPILED_JOB_DISABLED_COMPILER_VERSIONS,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_ENABLED_POLICY_VERSIONS !== undefined
      ? {
          enabledPolicyVersions: normalizeStringList(
            env.AGENC_COMPILED_JOB_ENABLED_POLICY_VERSIONS,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_DISABLED_POLICY_VERSIONS !== undefined
      ? {
          disabledPolicyVersions: normalizeStringList(
            env.AGENC_COMPILED_JOB_DISABLED_POLICY_VERSIONS,
          ),
        }
      : {}),
  };
}

function normalizeStringList(
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
