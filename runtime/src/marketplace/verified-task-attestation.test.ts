import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeVerifiedTaskAttestation,
  verifyVerifiedTaskAttestation,
  type VerifiedTaskAttestation,
} from "./verified-task-attestation.js";

const JOB_SPEC_HASH = "a".repeat(64);
const CANONICAL_TASK_HASH = "b".repeat(64);
const SAFETY_DECISION_HASH = "c".repeat(64);
const CAPABILITY_PROFILE_HASH = "d".repeat(64);
const ISSUED_AT = "2026-04-20T12:00:00.000Z";
const EXPIRES_AT = "2026-04-20T12:15:00.000Z";

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function makeAttestation(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  overrides: Partial<VerifiedTaskAttestation> = {},
): VerifiedTaskAttestation {
  const unsignedPayload = {
    id: "att-test-1",
    kind: "agenc.marketplace.verifiedTaskAttestation" as const,
    schemaVersion: 1 as const,
    environment: "devnet" as const,
    issuer: "agenc-services-storefront" as const,
    issuerKeyId: "storefront-devnet-1",
    orderId: "order-1",
    serviceTemplateId: "svc-1",
    jobSpecHash: JOB_SPEC_HASH,
    canonicalTaskHash: CANONICAL_TASK_HASH,
    buyerWallet: "Buyer11111111111111111111111111111111111111",
    paymentSignature: "payment-sig-1",
    nonce: "approval-1",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    policyVersion: "task-safety-policy-v1",
    safetyGateVersion: "deterministic-packet-v1",
    safetyDecisionHash: SAFETY_DECISION_HASH,
    riskLevel: "medium" as const,
    capabilityProfileHash: CAPABILITY_PROFILE_HASH,
    templateVersion: "2026-04-20T11:00:00.000Z",
    approvalId: "approval-1",
    approvedBy: "operator",
    approvedAt: ISSUED_AT,
    ...overrides,
  };
  const verifiedTaskHash = sha256Hex(canonicalJson(unsignedPayload));
  const signedPayload = {
    ...unsignedPayload,
    verifiedTaskHash,
    verifiedTaskUri: `agenc://verified-task/devnet/${verifiedTaskHash}`,
  };
  const signature = signBytes(
    null,
    Buffer.from(canonicalJson(signedPayload)),
    privateKey,
  ).toString("base64url");

  return {
    ...signedPayload,
    signature,
  };
}

describe("verified task attestation", () => {
  it("verifies a signed storefront attestation", () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const attestation = makeAttestation(privateKey);

    const result = verifyVerifiedTaskAttestation({
      attestation,
      expectedJobSpecHash: JOB_SPEC_HASH,
      trustedKeys: [{ issuerKeyId: "storefront-devnet-1", publicKeyPem }],
      now: new Date("2026-04-20T12:05:00.000Z"),
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.attestation.verifiedTaskUri).toBe(
        `agenc://verified-task/devnet/${result.attestation.verifiedTaskHash}`,
      );
    }
  });

  it("rejects attestations bound to a different job spec", () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const attestation = makeAttestation(privateKey);

    const result = verifyVerifiedTaskAttestation({
      attestation,
      expectedJobSpecHash: "e".repeat(64),
      trustedKeys: [{ issuerKeyId: "storefront-devnet-1", publicKeyPem }],
      now: new Date("2026-04-20T12:05:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("jobSpecHash"),
    });
  });

  it("rejects signed-payload tampering", () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const attestation = {
      ...makeAttestation(privateKey),
      approvedBy: "attacker",
    };

    const result = verifyVerifiedTaskAttestation({
      attestation,
      expectedJobSpecHash: JOB_SPEC_HASH,
      trustedKeys: [{ issuerKeyId: "storefront-devnet-1", publicKeyPem }],
      now: new Date("2026-04-20T12:05:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("hash does not match"),
    });
  });

  it("rejects expired attestations during verification but still normalizes them for stored links", () => {
    const { publicKeyPem, privateKey } = makeKeyPair();
    const attestation = makeAttestation(privateKey, {
      issuedAt: "2026-04-20T11:00:00.000Z",
      expiresAt: "2026-04-20T11:05:00.000Z",
      approvedAt: "2026-04-20T11:00:00.000Z",
    });

    const result = verifyVerifiedTaskAttestation({
      attestation,
      expectedJobSpecHash: JOB_SPEC_HASH,
      trustedKeys: [{ issuerKeyId: "storefront-devnet-1", publicKeyPem }],
      now: new Date("2026-04-20T12:05:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("expired"),
    });
    expect(
      normalizeVerifiedTaskAttestation(attestation, JOB_SPEC_HASH).verifiedTaskHash,
    ).toBe(attestation.verifiedTaskHash);
  });

  it("rejects attestations when no trusted key matches issuerKeyId", () => {
    const { privateKey } = makeKeyPair();
    const attestation = makeAttestation(privateKey);

    const result = verifyVerifiedTaskAttestation({
      attestation,
      expectedJobSpecHash: JOB_SPEC_HASH,
      trustedKeys: [],
      now: new Date("2026-04-20T12:05:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("no trusted public key"),
    });
  });
});

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
