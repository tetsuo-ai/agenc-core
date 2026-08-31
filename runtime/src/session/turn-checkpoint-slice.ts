/**
 * Versioned serialized state carried by durable turn checkpoints.
 *
 * Keep the key sets here so the writer, strict reader, event types, and
 * contract tests cannot define the checkpoint slice independently.
 */

export const MAX_CHECKPOINT_FALLBACK_TEXT_BYTES = 4_096;

export const LEGACY_TURN_CHECKPOINT_SLICE_KEYS = Object.freeze([
  "autoCompactTracking",
  "continuationNudgeCount",
  "maxOutputTokensRecoveryCount",
  "modelSampleOrdinal",
  "modelSampleResumePrompt",
  "pendingBudgetDecision",
  "planToolRequiredRetryCount",
  "recoveryReentryCount",
  "stopHookBlockingCount",
  "taskBudgetRemaining",
  "transition",
  "turnCount",
] as const);

export const TURN_CHECKPOINT_SLICE_KEYS = Object.freeze([
  ...LEGACY_TURN_CHECKPOINT_SLICE_KEYS,
  "editorToolCallsAdmitted",
  "pendingAdmissionFallback",
] as const);

export const PENDING_ADMISSION_FALLBACK_KEYS = Object.freeze([
  "fromModel",
  "fromProvider",
  "reason",
  "toModel",
  "toProvider",
] as const);

export interface PendingAdmissionFallbackSlice {
  readonly fromModel: string;
  readonly toModel: string;
  readonly fromProvider?: string;
  readonly toProvider?: string;
  readonly reason: string;
}

export interface TurnCheckpointSliceLine {
  readonly turnCount: number;
  readonly recoveryReentryCount: number;
  readonly maxOutputTokensRecoveryCount: number;
  readonly continuationNudgeCount: number;
  readonly stopHookBlockingCount: number;
  readonly planToolRequiredRetryCount?: number;
  readonly editorToolCallsAdmitted?: number;
  readonly pendingAdmissionFallback?: PendingAdmissionFallbackSlice;
  readonly modelSampleOrdinal?: number;
  readonly modelSampleResumePrompt?: "continuation_nudge" | "empty_response";
  readonly taskBudgetRemaining?: number;
  readonly autoCompactTracking?: {
    readonly compacted: boolean;
    readonly turnId: string;
    readonly turnCounter: number;
    readonly consecutiveFailures: number;
  };
  readonly transition?: { readonly reason: string };
  readonly pendingBudgetDecision?:
    | { readonly kind: "continue"; readonly remaining: number }
    | { readonly kind: "stop"; readonly reason: string };
}

export type LegacyTurnCheckpointSliceLine = Omit<
  TurnCheckpointSliceLine,
  "editorToolCallsAdmitted" | "pendingAdmissionFallback"
> & {
  readonly editorToolCallsAdmitted?: never;
  readonly pendingAdmissionFallback?: never;
};

export type PendingAdmissionFallbackValidation =
  | { readonly ok: true; readonly value: PendingAdmissionFallbackSlice }
  | { readonly ok: false; readonly reason: string };

/** Validate and clone the exact fallback envelope stored in a checkpoint. */
export function validatePendingAdmissionFallbackSlice(
  value: unknown,
  field = "pendingAdmissionFallback",
  options: { readonly allowUnknownFields?: boolean } = {},
): PendingAdmissionFallbackValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: `${field} must be an object` };
  }
  if (
    options.allowUnknownFields !== true &&
    !hasExactKeys(value, PENDING_ADMISSION_FALLBACK_KEYS)
  ) {
    return { ok: false, reason: `${field} contains unversioned fields` };
  }
  const fromModel = boundedRequiredText(value.fromModel, `${field}.fromModel`);
  if (!fromModel.ok) return fromModel;
  const toModel = boundedRequiredText(value.toModel, `${field}.toModel`);
  if (!toModel.ok) return toModel;
  const reason = boundedRequiredText(value.reason, `${field}.reason`);
  if (!reason.ok) return reason;

  const fromProvider = optionalBoundedText(
    value.fromProvider,
    `${field}.fromProvider`,
  );
  if (!fromProvider.ok) return fromProvider;
  const toProvider = optionalBoundedText(
    value.toProvider,
    `${field}.toProvider`,
  );
  if (!toProvider.ok) return toProvider;

  return {
    ok: true,
    value: {
      fromModel: fromModel.value,
      toModel: toModel.value,
      reason: reason.value,
      ...(fromProvider.value !== undefined
        ? { fromProvider: fromProvider.value }
        : {}),
      ...(toProvider.value !== undefined
        ? { toProvider: toProvider.value }
        : {}),
    },
  };
}

type TextValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

type OptionalTextValidation =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly reason: string };

function boundedRequiredText(value: unknown, field: string): TextValidation {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `${field} must be a non-empty string` };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CHECKPOINT_FALLBACK_TEXT_BYTES) {
    return {
      ok: false,
      reason: `${field} exceeds ${MAX_CHECKPOINT_FALLBACK_TEXT_BYTES} UTF-8 bytes`,
    };
  }
  return { ok: true, value };
}

function optionalBoundedText(
  value: unknown,
  field: string,
): OptionalTextValidation {
  if (value === undefined) return { ok: true, value: undefined };
  return boundedRequiredText(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sortedExpected = [...expected]
    .filter((key) => value[key] !== undefined)
    .sort(compareCodeUnits);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
