/**
 * Workflow verification results — collapsed type stub (Cut 1.1).
 *
 * Replaces the previous 127-LOC channel-decision builder API used by
 * the deleted planner verifier. Kept as opaque types so workflow/index
 * still re-exports cleanly.
 *
 * @module
 */

import type {
  DelegationOutputValidationCode,
  DelegationOutputValidationResult,
} from "../utils/delegation-validation.js";

export const RUNTIME_VERIFICATION_CHANNEL_NAMES = [
  "artifact_state",
  "placeholder_stub",
  "executable_outcome",
  "rubric",
] as const;

export type RuntimeVerificationChannelName =
  typeof RUNTIME_VERIFICATION_CHANNEL_NAMES[number];

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
): RuntimeVerificationDecision {
  return { ok: true, channels };
}

export function verificationFail(
  code: DelegationOutputValidationCode,
  message: string,
): RuntimeVerificationDecision {
  return {
    ok: false,
    diagnostic: { code, message },
    channels: [],
  };
}

export function verificationChannelPass(params: {
  channel: RuntimeVerificationChannelName;
  message: string;
  evidence?: readonly string[];
}): RuntimeVerificationChannelDecision {
  return { channel: params.channel, ok: true, message: params.message, evidence: params.evidence };
}

export function verificationChannelFail(params: {
  channel: RuntimeVerificationChannelName;
  message: string;
  diagnostic?: RuntimeVerificationDiagnostic;
}): RuntimeVerificationChannelDecision {
  return { channel: params.channel, ok: false, message: params.message, diagnostic: params.diagnostic };
}

export function resolveRuntimeVerificationDecision(_params: {
  readonly channels: readonly RuntimeVerificationChannelDecision[];
}): RuntimeVerificationDecision {
  return { ok: true, channels: [] };
}

export function toDelegationOutputValidationResult(
  _params: Record<string, unknown>,
): DelegationOutputValidationResult | undefined {
  return undefined;
}
