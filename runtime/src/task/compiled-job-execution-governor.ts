import { BudgetStateService } from "../policy/budget-state.js";

export interface CompiledJobExecutionRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface CompiledJobExecutionBudgetControls {
  readonly maxConcurrentRuns?: number;
  readonly maxConcurrentRunsByJobType?: Readonly<Record<string, number>>;
  readonly executionRateLimit?: CompiledJobExecutionRateLimit;
  readonly executionRateLimitByJobType?: Readonly<
    Record<string, CompiledJobExecutionRateLimit>
  >;
}

export interface ResolveCompiledJobExecutionBudgetControlsOptions {
  readonly base?: Partial<CompiledJobExecutionBudgetControls>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CompiledJobExecutionLease {
  release(): void;
}

export type CompiledJobExecutionDenyReason =
  | "execution_global_concurrency_limit"
  | "execution_job_type_concurrency_limit"
  | "execution_global_rate_limit"
  | "execution_job_type_rate_limit";

export interface CompiledJobExecutionDecision {
  readonly allowed: boolean;
  readonly reason?: CompiledJobExecutionDenyReason;
  readonly message?: string;
  readonly lease?: CompiledJobExecutionLease;
}

export interface CompiledJobExecutionGovernor {
  acquire(jobType: string): CompiledJobExecutionDecision;
}

export interface CreateCompiledJobExecutionGovernorOptions {
  readonly controls?: CompiledJobExecutionBudgetControls;
  readonly now?: () => number;
}

const GLOBAL_RATE_BUCKET = "__compiled_job_global__";
export function resolveCompiledJobExecutionBudgetControls(
  options: ResolveCompiledJobExecutionBudgetControlsOptions = {},
): CompiledJobExecutionBudgetControls {
  const envControls = readCompiledJobExecutionBudgetControlsFromEnv(options.env);
  const base = options.base ?? {};
  return {
    ...(resolvePositiveInteger(
      base.maxConcurrentRuns ?? envControls.maxConcurrentRuns,
    ) !== undefined
      ? {
          maxConcurrentRuns: resolvePositiveInteger(
            base.maxConcurrentRuns ?? envControls.maxConcurrentRuns,
          ),
        }
      : {}),
    maxConcurrentRunsByJobType: normalizePositiveIntegerMap(
      base.maxConcurrentRunsByJobType ?? envControls.maxConcurrentRunsByJobType,
    ),
    ...(normalizeRateLimit(
      base.executionRateLimit ?? envControls.executionRateLimit,
    )
      ? {
          executionRateLimit: normalizeRateLimit(
            base.executionRateLimit ?? envControls.executionRateLimit,
          ),
        }
      : {}),
    executionRateLimitByJobType: normalizeRateLimitMap(
      base.executionRateLimitByJobType ??
        envControls.executionRateLimitByJobType,
    ),
  };
}

export function createCompiledJobExecutionGovernor(
  options: CreateCompiledJobExecutionGovernorOptions = {},
): CompiledJobExecutionGovernor {
  const controls = options.controls ?? {};
  const now = options.now ?? (() => Date.now());
  const globalRateState = controls.executionRateLimit
    ? new BudgetStateService({
        rateWindowMs: controls.executionRateLimit.windowMs,
      })
    : null;
  const perJobRateState = new Map<string, BudgetStateService>();
  const activeByJobType = new Map<string, number>();
  let activeGlobal = 0;

  const getPerJobRateState = (
    jobType: string,
  ): BudgetStateService | null => {
    const rateLimit = controls.executionRateLimitByJobType?.[jobType];
    if (!rateLimit) return null;
    let state = perJobRateState.get(jobType);
    if (!state) {
      state = new BudgetStateService({
        rateWindowMs: rateLimit.windowMs,
      });
      perJobRateState.set(jobType, state);
    }
    return state;
  };

  return {
    acquire(jobType: string): CompiledJobExecutionDecision {
      const nowMs = now();
      const maxConcurrentRuns = controls.maxConcurrentRuns;
      if (
        maxConcurrentRuns !== undefined &&
        activeGlobal >= maxConcurrentRuns
      ) {
        return {
          allowed: false,
          reason: "execution_global_concurrency_limit",
          message:
            `Compiled marketplace job concurrency limit reached ` +
            `(${activeGlobal}/${maxConcurrentRuns} active)`,
        };
      }

      const perJobConcurrentLimit =
        controls.maxConcurrentRunsByJobType?.[jobType];
      const activeForJobType = activeByJobType.get(jobType) ?? 0;
      if (
        perJobConcurrentLimit !== undefined &&
        activeForJobType >= perJobConcurrentLimit
      ) {
        return {
          allowed: false,
          reason: "execution_job_type_concurrency_limit",
          message:
            `Compiled job type "${jobType}" concurrency limit reached ` +
            `(${activeForJobType}/${perJobConcurrentLimit} active)`,
        };
      }

      const globalRateLimit = controls.executionRateLimit;
      const globalRate = globalRateState?.toolCallRate(
        GLOBAL_RATE_BUCKET,
        nowMs,
      );
      if (
        globalRateLimit &&
        globalRate !== undefined &&
        globalRate >= globalRateLimit.limit
      ) {
        return {
          allowed: false,
          reason: "execution_global_rate_limit",
          message:
            `Compiled marketplace job rate limit exceeded ` +
            `(${globalRate}/${globalRateLimit.limit} per ${globalRateLimit.windowMs}ms)`,
        };
      }

      const perJobRateLimit = controls.executionRateLimitByJobType?.[jobType];
      const perJobRateStateForType = getPerJobRateState(jobType);
      const perJobRate = perJobRateStateForType?.toolCallRate(jobType, nowMs);
      if (
        perJobRateLimit &&
        perJobRate !== undefined &&
        perJobRate >= perJobRateLimit.limit
      ) {
        return {
          allowed: false,
          reason: "execution_job_type_rate_limit",
          message:
            `Compiled job type "${jobType}" rate limit exceeded ` +
            `(${perJobRate}/${perJobRateLimit.limit} per ${perJobRateLimit.windowMs}ms)`,
        };
      }

      globalRateState?.recordToolCall(GLOBAL_RATE_BUCKET, nowMs);
      perJobRateStateForType?.recordToolCall(jobType, nowMs);

      activeGlobal += 1;
      activeByJobType.set(jobType, activeForJobType + 1);
      let released = false;

      return {
        allowed: true,
        lease: {
          release(): void {
            if (released) return;
            released = true;
            activeGlobal = Math.max(0, activeGlobal - 1);
            const current = activeByJobType.get(jobType) ?? 0;
            if (current <= 1) {
              activeByJobType.delete(jobType);
              return;
            }
            activeByJobType.set(jobType, current - 1);
          },
        },
      };
    },
  };
}

function readCompiledJobExecutionBudgetControlsFromEnv(
  env: NodeJS.ProcessEnv | undefined,
): Partial<CompiledJobExecutionBudgetControls> {
  if (!env) {
    return {};
  }
  return {
    ...(resolvePositiveInteger(env.AGENC_COMPILED_JOB_MAX_CONCURRENT) !==
    undefined
      ? {
          maxConcurrentRuns: resolvePositiveInteger(
            env.AGENC_COMPILED_JOB_MAX_CONCURRENT,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_MAX_CONCURRENT_BY_TYPE !== undefined
      ? {
          maxConcurrentRunsByJobType: normalizePositiveIntegerMap(
            env.AGENC_COMPILED_JOB_MAX_CONCURRENT_BY_TYPE,
          ),
        }
      : {}),
    ...(normalizeRateLimit(env.AGENC_COMPILED_JOB_RATE_LIMIT) !== undefined
      ? {
          executionRateLimit: normalizeRateLimit(
            env.AGENC_COMPILED_JOB_RATE_LIMIT,
          ),
        }
      : {}),
    ...(env.AGENC_COMPILED_JOB_RATE_LIMIT_BY_TYPE !== undefined
      ? {
          executionRateLimitByJobType: normalizeRateLimitMap(
            env.AGENC_COMPILED_JOB_RATE_LIMIT_BY_TYPE,
          ),
        }
      : {}),
  };
}

function resolvePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizePositiveIntegerMap(
  value: Readonly<Record<string, number>> | string | undefined,
): Record<string, number> {
  if (typeof value === "string") {
    return parseJobTypeMap<number>(value, (raw) => {
      const parsed = resolvePositiveInteger(raw);
      return parsed ? { ok: true, value: parsed } : { ok: false };
    });
  }
  if (!value) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = resolvePositiveInteger(raw);
    if (!parsed) continue;
    result[key.trim()] = parsed;
  }
  return result;
}

function normalizeRateLimit(
  value: CompiledJobExecutionRateLimit | string | undefined,
): CompiledJobExecutionRateLimit | undefined {
  if (typeof value === "string") {
    const parsed = parseRateLimitString(value);
    return parsed ?? undefined;
  }
  if (!value) return undefined;
  const limit = resolvePositiveInteger(value.limit);
  const windowMs = resolvePositiveInteger(value.windowMs);
  if (!limit || !windowMs) return undefined;
  return { limit, windowMs };
}

function normalizeRateLimitMap(
  value:
    | Readonly<Record<string, CompiledJobExecutionRateLimit>>
    | string
    | undefined,
): Record<string, CompiledJobExecutionRateLimit> {
  if (typeof value === "string") {
    return parseJobTypeMap<CompiledJobExecutionRateLimit>(value, (raw) => {
      const parsed = parseRateLimitString(raw);
      return parsed ? { ok: true, value: parsed } : { ok: false };
    });
  }
  if (!value) return {};
  const result: Record<string, CompiledJobExecutionRateLimit> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = normalizeRateLimit(raw);
    if (!parsed) continue;
    result[key.trim()] = parsed;
  }
  return result;
}

function parseRateLimitString(
  value: string,
): CompiledJobExecutionRateLimit | null {
  const [limitRaw, windowRaw] = value.split("/");
  const limit = resolvePositiveInteger(limitRaw);
  const windowMs = resolvePositiveInteger(windowRaw);
  if (!limit || !windowMs) return null;
  return { limit, windowMs };
}

function parseJobTypeMap<T>(
  value: string,
  parseValue: (raw: string) => { ok: true; value: T } | { ok: false },
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const entry of value.split(",")) {
    const [jobTypeRaw, rawValue] = entry.split("=");
    const jobType = jobTypeRaw?.trim();
    if (!jobType || !rawValue) continue;
    const parsed = parseValue(rawValue.trim());
    if (!parsed.ok) continue;
    result[jobType] = parsed.value;
  }
  return result;
}
