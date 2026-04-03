import type {
  DelegationOutputValidationCode,
  DelegationOutputValidationResult,
} from "../utils/delegation-validation.js";

export type RuntimeVerificationChannelName =
  | "artifact_state"
  | "placeholder_stub"
  | "executable_outcome"
  | "rubric";

export interface RuntimeVerificationDiagnostic {
  readonly code: DelegationOutputValidationCode;
  readonly message: string;
}

export interface RuntimeVerificationChannelDecision {
  readonly channel: RuntimeVerificationChannelName;
  readonly ok: boolean;
  readonly message: string;
  readonly evidence?: readonly string[];
  readonly diagnostic?: RuntimeVerificationDiagnostic;
}

export interface RuntimeVerificationDecision {
  readonly ok: boolean;
  readonly compatibilityFallbackSuggested?: boolean;
  readonly diagnostic?: RuntimeVerificationDiagnostic;
  readonly channels: readonly RuntimeVerificationChannelDecision[];
}

export function verificationPass(
  channels: readonly RuntimeVerificationChannelDecision[] = [],
  compatibilityFallbackSuggested = false,
): RuntimeVerificationDecision {
  return {
    ok: true,
    channels,
    ...(compatibilityFallbackSuggested
      ? { compatibilityFallbackSuggested: true }
      : {}),
  };
}

export function verificationFail(
  code: DelegationOutputValidationCode,
  message: string,
  channels: readonly RuntimeVerificationChannelDecision[] = [],
): RuntimeVerificationDecision {
  return {
    ok: false,
    diagnostic: { code, message },
    channels,
  };
}

export function verificationChannelPass(params: {
  readonly channel: RuntimeVerificationChannelName;
  readonly message: string;
  readonly evidence?: readonly string[];
}): RuntimeVerificationChannelDecision {
  return {
    channel: params.channel,
    ok: true,
    message: params.message,
    ...(params.evidence && params.evidence.length > 0
      ? { evidence: params.evidence }
      : {}),
  };
}

export function verificationChannelFail(params: {
  readonly channel: RuntimeVerificationChannelName;
  readonly code: DelegationOutputValidationCode;
  readonly message: string;
  readonly evidence?: readonly string[];
}): RuntimeVerificationChannelDecision {
  return {
    channel: params.channel,
    ok: false,
    message: params.message,
    diagnostic: {
      code: params.code,
      message: params.message,
    },
    ...(params.evidence && params.evidence.length > 0
      ? { evidence: params.evidence }
      : {}),
  };
}

export function resolveRuntimeVerificationDecision(params: {
  readonly channels: readonly RuntimeVerificationChannelDecision[];
  readonly compatibilityFallbackSuggested?: boolean;
}): RuntimeVerificationDecision {
  const failedChannel = params.channels.find((channel) => !channel.ok);
  if (!failedChannel) {
    return verificationPass(
      params.channels,
      params.compatibilityFallbackSuggested ?? false,
    );
  }
  return verificationFail(
    failedChannel.diagnostic?.code ?? "acceptance_evidence_missing",
    failedChannel.diagnostic?.message ?? failedChannel.message,
    params.channels,
  );
}

export function toDelegationOutputValidationResult(params: {
  readonly decision: RuntimeVerificationDecision;
  readonly parsedOutput?: Record<string, unknown>;
}): DelegationOutputValidationResult | undefined {
  if (params.decision.ok || !params.decision.diagnostic) {
    return undefined;
  }
  return {
    ok: false,
    code: params.decision.diagnostic.code,
    error: params.decision.diagnostic.message,
    ...(params.parsedOutput ? { parsedOutput: params.parsedOutput } : {}),
  };
}
