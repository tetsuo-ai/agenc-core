import { createHash } from "node:crypto";

import type {
  EffectNoEffectProof,
  ToolEffectDispositionEvidence,
} from "../contracts/run-contracts.js";

interface PendingNoEffectProof {
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
}

export interface ToolEffectDispositionOptions {
  readonly disposition: ToolEffectDispositionEvidence["disposition"];
  readonly evidenceKind: ToolEffectDispositionEvidence["evidenceKind"];
  readonly evidenceRef: string;
  readonly evidenceMaterial?: string;
}

const NO_EFFECT_PROOFS = new WeakMap<object, PendingNoEffectProof>();

/**
 * Brand a trusted pre-effect error with authoritative boundary evidence.
 * Callers cannot manufacture the brand with similarly named string fields.
 */
export function markEffectBoundaryNotCrossed<T extends object>(
  error: T,
  options: {
    readonly evidenceRef: string;
    readonly evidenceMaterial?: string;
  },
): T {
  const evidenceRef = requireNonempty(options.evidenceRef, "evidenceRef");
  const evidenceMaterial = options.evidenceMaterial ?? evidenceRef;
  NO_EFFECT_PROOFS.set(error, {
    evidenceRef,
    evidenceSha256: createHash("sha256")
      .update(evidenceMaterial, "utf8")
      .digest("hex"),
  });
  return error;
}

export function readEffectBoundaryNotCrossed(
  error: unknown,
  observedAt: string,
): EffectNoEffectProof | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  const proof = NO_EFFECT_PROOFS.get(error);
  if (proof === undefined) return undefined;
  return {
    version: 1,
    kind: "effect_no_effect_proof",
    evidenceKind: "boundary_not_crossed",
    evidenceRef: proof.evidenceRef,
    evidenceSha256: proof.evidenceSha256,
    observedAt: requireNonempty(observedAt, "observedAt"),
  };
}

/** Build adapter evidence without exposing the evidence material to the model. */
export function createToolEffectDispositionEvidence(
  options: ToolEffectDispositionOptions,
): ToolEffectDispositionEvidence {
  const evidenceRef = requireNonempty(options.evidenceRef, "evidenceRef");
  const evidenceMaterial = options.evidenceMaterial ?? evidenceRef;
  return {
    disposition: options.disposition,
    evidenceKind: options.evidenceKind,
    evidenceRef,
    evidenceSha256: createHash("sha256")
      .update(evidenceMaterial, "utf8")
      .digest("hex"),
  };
}

export function validateToolEffectDispositionEvidence(
  value: ToolEffectDispositionEvidence | undefined,
): ToolEffectDispositionEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    value.disposition !== "confirmed_committed" &&
    value.disposition !== "confirmed_no_effect" &&
    value.disposition !== "remains_unknown"
  ) {
    throw new TypeError("effect disposition is invalid");
  }
  if (
    value.evidenceKind !== "provider_receipt" &&
    value.evidenceKind !== "idempotency_lookup" &&
    value.evidenceKind !== "boundary_not_crossed"
  ) {
    throw new TypeError("effect evidence kind is invalid");
  }
  requireNonempty(value.evidenceRef, "effect evidence reference");
  if (!/^[0-9a-f]{64}$/u.test(value.evidenceSha256)) {
    throw new TypeError("effect evidence digest must be lowercase sha256");
  }
  return value;
}

function requireNonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
