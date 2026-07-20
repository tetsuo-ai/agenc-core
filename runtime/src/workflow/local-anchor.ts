/**
 * M5 local integrity-only anchor crypto for per-run workflow evidence
 * ledgers.
 *
 * One shared construction with two consumers:
 *   - the daemon evidence-ledger factory (`daemon-wiring.ts`) uses it to
 *     ANCHOR seals (it owns the per-daemon-home secret and may create it),
 *   - the offline evidence reconstruction (`evidence-reconstruction.ts`)
 *     uses it to VERIFY a seal from an exported bundle (read-only; the
 *     secret must already exist in the bundle).
 *
 * The signature is sha256(secret || statementBytes) keyed by a per-home
 * random secret, so a seal cannot be silently reforged by editing ledger
 * files. It is NOT an external anchor — the trust statement stays
 * "integrity_only" and external anchoring remains an explicit later
 * concern. The policy/verifier digest strings below are part of every
 * recorded seal receipt; changing them invalidates existing seals.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { sha256Digest } from "../eval-contract/canonical-json.js";
import type {
  EvidenceAnchorProvider,
  EvidenceAnchorVerifier,
} from "../eval-contract/evidence-ledger.js";
import type { Sha256Digest } from "../eval-contract/types.js";

export const WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME = "local-anchor-secret";

export const WORKFLOW_LOCAL_ANCHOR_POLICY_DIGEST: Sha256Digest = sha256Digest(
  "agenc.workflow.m5.local-anchor.v1",
);
export const WORKFLOW_LOCAL_ANCHOR_VERIFIER_DIGEST: Sha256Digest = sha256Digest(
  "agenc.workflow.m5.local-anchor-verifier.v1",
);

export interface WorkflowLocalAnchorCrypto {
  readonly anchorPolicyDigest: Sha256Digest;
  readonly verifierDigest: Sha256Digest;
  readonly verificationMaterialDigest: Sha256Digest;
  signatureFor(bytes: Uint8Array): Sha256Digest;
}

/** Deterministic keyed-signature construction over the exact secret bytes. */
export function createWorkflowLocalAnchorCrypto(
  secret: Uint8Array,
): WorkflowLocalAnchorCrypto {
  const verificationMaterialDigest = sha256Digest(secret);
  return {
    anchorPolicyDigest: WORKFLOW_LOCAL_ANCHOR_POLICY_DIGEST,
    verifierDigest: WORKFLOW_LOCAL_ANCHOR_VERIFIER_DIGEST,
    verificationMaterialDigest,
    signatureFor(bytes: Uint8Array): Sha256Digest {
      const joined = new Uint8Array(secret.byteLength + bytes.byteLength);
      joined.set(secret, 0);
      joined.set(bytes, secret.byteLength);
      return sha256Digest(joined);
    },
  };
}

/** Anchor provider over an existing secret (creation is the caller's job). */
export function workflowLocalAnchorProvider(
  secret: Uint8Array,
): EvidenceAnchorProvider {
  const crypto = createWorkflowLocalAnchorCrypto(secret);
  return {
    anchorPolicyDigest: crypto.anchorPolicyDigest,
    verifierDigest: crypto.verifierDigest,
    async anchor(statementBytes, statementDigest) {
      return {
        statementDigest,
        anchorPolicyDigest: crypto.anchorPolicyDigest,
        signatureAlgorithm: "ed25519",
        signatureDigest: crypto.signatureFor(statementBytes),
        verificationMaterialDigest: crypto.verificationMaterialDigest,
        // The seal schema requires an https URI; the reserved `.invalid`
        // TLD makes the local-only (non-fetchable) anchoring explicit.
        anchorUri: `https://local-anchor.agenc-daemon.invalid/${statementDigest.slice("sha256:".length)}`,
        signerIdentity: "agenc-daemon-local-anchor",
      };
    },
    verify(statementBytes, receipt) {
      return (
        receipt.signatureDigest === crypto.signatureFor(statementBytes) &&
        receipt.verificationMaterialDigest === crypto.verificationMaterialDigest
      );
    },
  };
}

/** Verifier-only view for offline reconstruction. */
export function workflowLocalAnchorVerifier(
  secret: Uint8Array,
): EvidenceAnchorVerifier {
  const provider = workflowLocalAnchorProvider(secret);
  return {
    anchorPolicyDigest: provider.anchorPolicyDigest,
    verifierDigest: provider.verifierDigest,
    verify: (statementBytes, receipt) =>
      provider.verify(statementBytes, receipt),
  };
}

/**
 * Locate the anchor secret for an exported bundle directory: inside the
 * bundle itself first (self-contained export), then the parent directory
 * (a bundle pointed at the live `<agencHome>/run-evidence/<runId>` layout).
 * Returns undefined when no secret is present — callers must fail loudly,
 * never silently downgrade verification.
 */
export async function readWorkflowLocalAnchorSecret(
  bundleDir: string,
): Promise<Uint8Array | undefined> {
  for (const candidate of [
    path.join(bundleDir, WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME),
    path.join(path.dirname(bundleDir), WORKFLOW_LOCAL_ANCHOR_SECRET_FILENAME),
  ]) {
    try {
      return await readFile(candidate);
    } catch {
      // try the next location
    }
  }
  return undefined;
}
