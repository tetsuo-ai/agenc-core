import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import {
  appendEvidenceEvent,
  initializeEvidenceLedger,
  isExternallyVerifiedEvidenceLedger,
  sealEvidenceLedger,
  verifyEvidenceLedger,
  verifyLocalEvidenceLedger,
  type EvidenceAnchorProvider,
} from "../../src/eval-contract/evidence-ledger.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import contractSchema from "../../src/eval-contract/contract-v1.schema.json" with { type: "json" };
import { workflowLocalAnchorProvider, workflowLocalAnchorVerifier } from "../../src/workflow/local-anchor.js";

const workspaces = createTempWorkspaceFixture("agenc-local-seal-trust-");
const SECRET = Buffer.from("test-only-local-integrity-key");
const NOW = "2026-09-09T00:00:00.000Z";
afterEach(async () => { await workspaces.cleanup(); });

async function sealedLedger(provider: EvidenceAnchorProvider) {
  const root = await workspaces.create();
  const access = {
    root,
    platformProtection: { verifierDigest: sha256Digest("test-platform"), verify: async () => true },
  };
  const context = { runId: "run-local-trust", taskId: "task-local-trust", systemId: "system-test", contractDigest: sha256Digest("contract") };
  await initializeEvidenceLedger(access, context.runId);
  for (const type of ["run.started", "run.finished"] as const) {
    await appendEvidenceEvent({
      ...access,
      event: {
        ...context, eventId: type, type, occurredAt: NOW, mediaType: "application/json",
        redactionPolicyDigest: sha256Digest("redaction"),
        producer: { identity: "test", version: "1.0.0", binaryDigest: sha256Digest("test-producer") },
      },
      payloadBytes: Buffer.from("{}"),
    });
  }
  const seal = await sealEvidenceLedger({ ...access, context, sealedAt: NOW, anchorProvider: provider });
  return { ...access, context, runId: context.runId, expectedSealDigest: seal.sealDigest, seal };
}

describe("workflow local seal trust", () => {
  it("keeps HMAC out of every external score-reference receipt schema", () => {
    expect(contractSchema.definitions.evidenceSeal.properties.receipt.properties.signatureAlgorithm.enum).toContain("hmac-sha256");
    expect(JSON.stringify(contractSchema).match(/"signatureAlgorithm":\{"enum":\[[^\]]*"hmac-sha256"/gu)).toHaveLength(1);
  });

  it("labels the local receipt as HMAC-SHA256 and computes that MAC", async () => {
    const provider = workflowLocalAnchorProvider(SECRET);
    const statement = Buffer.from("test statement");
    const receipt = await provider.anchor(statement, sha256Digest(statement));
    expect(receipt.signatureAlgorithm).toBe("hmac-sha256");
    expect(receipt.signatureDigest).toBe(`sha256:${createHmac("sha256", SECRET).update(statement).digest("hex")}`);
    expect(await provider.verify(statement, receipt)).toBe(true);
  });

  it("refuses to brand a local shared-secret seal as externally verified", async () => {
    const fixture = await sealedLedger(workflowLocalAnchorProvider(SECRET));
    await expect(verifyEvidenceLedger({ ...fixture, anchorVerifier: workflowLocalAnchorVerifier(SECRET) }))
      .rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
  });

  it("refuses a local receipt relabeled as an asymmetric signature", async () => {
    const provider = workflowLocalAnchorProvider(SECRET);
    const statement = Buffer.from("test statement");
    const receipt = await provider.anchor(statement, sha256Digest(statement));
    expect(await provider.verify(statement, { ...receipt, signatureAlgorithm: "ecdsa-p256-sha256" })).toBe(false);
  });

  it("verifies a local seal without granting the external runtime brand", async () => {
    const fixture = await sealedLedger(workflowLocalAnchorProvider(SECRET));
    const local = await verifyLocalEvidenceLedger({ ...fixture, anchorVerifier: workflowLocalAnchorVerifier(SECRET) });
    expect(local.trust).toBe("integrity_only");
    expect(local.seal.receipt.signatureAlgorithm).toBe("hmac-sha256");
    expect(isExternallyVerifiedEvidenceLedger(local)).toBe(false);
    expect(isExternallyVerifiedEvidenceLedger({ ...local, trust: "externally_anchored" })).toBe(false);
    expect(Object.isFrozen(local)).toBe(true);
    expect(Object.isFrozen(local.seal.receipt)).toBe(true);
    await expect(verifyLocalEvidenceLedger({ ...fixture, anchorVerifier: workflowLocalAnchorVerifier(Buffer.from("wrong-secret")) }))
      .rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
  });

  it("rejects a local verifier claiming external trust even if its MAC is valid", async () => {
    const fixture = await sealedLedger(workflowLocalAnchorProvider(SECRET));
    await expect(verifyEvidenceLedger({
      ...fixture,
      anchorVerifier: { ...workflowLocalAnchorVerifier(SECRET), trustClass: "externally_anchored" },
    })).rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
  });

  it("rejects unclassified verifiers instead of upgrading an arbitrary successful callback", async () => {
    const fixture = await sealedLedger(workflowLocalAnchorProvider(SECRET));
    const verifier = { ...workflowLocalAnchorVerifier(SECRET), verify: () => true };
    Reflect.deleteProperty(verifier, "trustClass");
    await expect(verifyEvidenceLedger({ ...fixture, anchorVerifier: verifier }))
      .rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
    await expect(verifyLocalEvidenceLedger({ ...fixture, anchorVerifier: verifier }))
      .rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
  });

  it("checks the pinned algorithm before invoking a permissive verifier callback", async () => {
    const fixture = await sealedLedger(workflowLocalAnchorProvider(SECRET));
    const verifyReceipt = vi.fn(() => true);
    await expect(verifyLocalEvidenceLedger({
      ...fixture,
      anchorVerifier: { ...workflowLocalAnchorVerifier(SECRET), signatureAlgorithm: "ed25519", verify: verifyReceipt },
    })).rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  it("checks algorithm pins both before persisting and when recovering a stored seal", async () => {
    const provider = workflowLocalAnchorProvider(SECRET);
    const mismatched: EvidenceAnchorProvider = { ...provider, signatureAlgorithm: "ed25519", verify: () => true };
    await expect(sealedLedger(mismatched)).rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
    const fixture = await sealedLedger(provider);
    await expect(sealEvidenceLedger({ ...fixture, sealedAt: NOW, anchorProvider: mismatched }))
      .rejects.toMatchObject({ code: "EVIDENCE_UNANCHORED" });
    expect(await sealEvidenceLedger({ ...fixture, sealedAt: NOW, anchorProvider: provider })).toEqual(fixture.seal);
  });

  it("rejects legacy local v1 receipts with an unsupported-version explanation", async () => {
    const anchorPolicyDigest = sha256Digest("agenc.workflow.m5.local-anchor.v1");
    const signatureFor = (statement: Uint8Array) => sha256Digest(Buffer.concat([SECRET, Buffer.from(statement)]));
    const legacyProvider: EvidenceAnchorProvider = {
      trustClass: "integrity_only", signatureAlgorithm: "ed25519",
      anchorPolicyDigest, verifierDigest: sha256Digest("agenc.workflow.m5.local-anchor-verifier.v1"),
      anchor: async (statement, statementDigest) => ({
        statementDigest, anchorPolicyDigest, signatureAlgorithm: "ed25519",
        signatureDigest: signatureFor(statement), verificationMaterialDigest: sha256Digest(SECRET),
        anchorUri: "https://local-anchor.agenc-daemon.invalid/legacy", signerIdentity: "agenc-daemon-local-anchor",
      }),
      verify: (statement, receipt) => receipt.signatureDigest === signatureFor(statement),
    };
    const fixture = await sealedLedger(legacyProvider);
    await expect(verifyLocalEvidenceLedger({ ...fixture, anchorVerifier: workflowLocalAnchorVerifier(SECRET) }))
      .rejects.toThrow(/unsupported receipt version/u);
  });

  it("copies the supplied secret rather than changing keys when its buffer is mutated", async () => {
    const supplied = Buffer.from(SECRET);
    const provider = workflowLocalAnchorProvider(supplied);
    const statement = Buffer.from("test statement");
    const before = await provider.anchor(statement, sha256Digest(statement));
    supplied.fill(0);
    expect(await provider.anchor(statement, sha256Digest(statement))).toEqual(before);
    expect(await provider.verify(statement, before)).toBe(true);
  });

  it("preserves external trust with a real Ed25519 signature and independently pinned public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signatures = new Map<string, Buffer>();
    const verificationMaterialDigest = sha256Digest(publicKey.export({ format: "der", type: "spki" }));
    const anchorPolicyDigest = sha256Digest("test-external-policy");
    const verifierDigest = sha256Digest("test-ed25519-verifier");
    const provider = {
      trustClass: "externally_anchored" as const,
      signatureAlgorithm: "ed25519" as const,
      anchorPolicyDigest,
      verifierDigest,
      anchor: async (statement: Uint8Array, statementDigest: `sha256:${string}`) => {
        const signature = sign(null, statement, privateKey);
        const signatureDigest = sha256Digest(signature);
        signatures.set(signatureDigest, signature);
        return {
          statementDigest, anchorPolicyDigest, signatureAlgorithm: "ed25519" as const,
          signatureDigest, verificationMaterialDigest, signerIdentity: "test-external-signer",
          anchorUri: "https://external.example.invalid/receipt",
        };
      },
      verify: (statement: Uint8Array, receipt: Awaited<ReturnType<EvidenceAnchorProvider["anchor"]>>) => {
        const signature = signatures.get(receipt.signatureDigest);
        return receipt.signatureAlgorithm === "ed25519" &&
          receipt.verificationMaterialDigest === verificationMaterialDigest && signature !== undefined &&
          verify(null, statement, publicKey, signature);
      },
    };
    const fixture = await sealedLedger(provider);
    const verifier = {
      trustClass: provider.trustClass, signatureAlgorithm: provider.signatureAlgorithm,
      anchorPolicyDigest, verifierDigest, verify: provider.verify,
    };
    const result = await verifyEvidenceLedger({ ...fixture, anchorVerifier: verifier });
    expect(result.trust).toBe("externally_anchored");
    expect(isExternallyVerifiedEvidenceLedger(result)).toBe(true);
  });
});
