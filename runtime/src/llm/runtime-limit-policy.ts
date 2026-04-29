const UNLIMITED_RUNTIME_LIMIT = 0;

interface NormalizeRuntimeLimitOptions {
  readonly min?: number;
  readonly max?: number;
}

function clampLimitedRuntimeValue(
  value: number,
  options?: NormalizeRuntimeLimitOptions,
): number {
  const min = Math.max(1, Math.floor(options?.min ?? 1));
  let normalized = Math.max(min, Math.floor(value));
  if (
    typeof options?.max === "number" &&
    Number.isFinite(options.max) &&
    options.max > 0
  ) {
    normalized = Math.min(normalized, Math.floor(options.max));
  }
  return normalized;
}

export function hasRuntimeLimit(value: number | undefined | null): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.floor(value) > UNLIMITED_RUNTIME_LIMIT
  );
}

export function normalizeRuntimeLimit(
  value: number | undefined,
  fallback: number,
  options?: NormalizeRuntimeLimitOptions,
): number {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : Math.floor(fallback);
  if (raw <= UNLIMITED_RUNTIME_LIMIT) {
    return UNLIMITED_RUNTIME_LIMIT;
  }
  return clampLimitedRuntimeValue(raw, options);
}

export function normalizeOptionalRuntimeLimit(
  value: unknown,
  options?: NormalizeRuntimeLimitOptions,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const raw = Math.floor(value);
  if (raw <= UNLIMITED_RUNTIME_LIMIT) {
    return UNLIMITED_RUNTIME_LIMIT;
  }
  return clampLimitedRuntimeValue(raw, options);
}

export function isRuntimeLimitReached(
  used: number,
  limit: number | undefined | null,
): boolean {
  return hasRuntimeLimit(limit) && used >= Number(limit);
}

export function isRuntimeLimitExceeded(
  used: number,
  limit: number | undefined | null,
): boolean {
  return hasRuntimeLimit(limit) && used > Number(limit);
}

export function resolveRuntimeTimeoutMs(params: {
  readonly configuredTimeoutMs: number | undefined | null;
  readonly requestDeadlineAt: number;
  readonly now?: number;
}): number | undefined {
  const now = params.now ?? Date.now();
  const remainingRequestMs = Number.isFinite(params.requestDeadlineAt)
    ? Math.max(1, Math.floor(params.requestDeadlineAt - now))
    : undefined;
  if (hasRuntimeLimit(params.configuredTimeoutMs)) {
    const configuredTimeoutMs = Math.floor(Number(params.configuredTimeoutMs));
    return remainingRequestMs === undefined
      ? configuredTimeoutMs
      : Math.min(configuredTimeoutMs, remainingRequestMs);
  }
  return remainingRequestMs;
}
