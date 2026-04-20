import {
  createHash,
  createPublicKey,
  verify as verifySignatureBytes,
} from "node:crypto";

const ATTESTATION_SCHEMA_VERSION = 1;
const ATTESTATION_KIND = "agenc.marketplace.verifiedTaskAttestation";
const DEFAULT_ISSUER = "agenc-services-storefront";
const DEFAULT_ENVIRONMENT = "devnet";
const HASH_RE = /^[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TRUST_KEYS_ENV = "AGENC_VERIFIED_TASK_PUBLIC_KEYS";
const TRUST_KEY_ENV = "AGENC_VERIFIED_TASK_PUBLIC_KEY";
const TRUST_KEY_ID_ENV = "AGENC_VERIFIED_TASK_KEY_ID";
const DEFAULT_TRUST_KEY_ID = "storefront-devnet-1";

export type VerifiedTaskRiskLevel = "low" | "medium" | "high" | "critical";

export interface VerifiedTaskAttestation {
  readonly id: string;
  readonly kind: typeof ATTESTATION_KIND;
  readonly schemaVersion: typeof ATTESTATION_SCHEMA_VERSION;
  readonly environment: typeof DEFAULT_ENVIRONMENT;
  readonly issuer: typeof DEFAULT_ISSUER;
  readonly issuerKeyId: string;
  readonly orderId: string;
  readonly serviceTemplateId: string;
  readonly jobSpecHash: string;
  readonly canonicalTaskHash: string;
  readonly buyerWallet?: string;
  readonly paymentSignature?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly policyVersion: string;
  readonly safetyGateVersion: string;
  readonly safetyDecisionHash: string;
  readonly riskLevel: VerifiedTaskRiskLevel;
  readonly capabilityProfileHash: string;
  readonly templateVersion: string;
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly verifiedTaskHash: string;
  readonly verifiedTaskUri: string;
  readonly signature: string;
}

export interface VerifiedTaskAttestationTrustKey {
  readonly issuerKeyId: string;
  readonly publicKeyPem: string;
  readonly issuer?: string;
  readonly environment?: string;
}

export interface VerifiedTaskAttestationVerificationInput {
  readonly attestation: unknown;
  readonly trustedKeys: readonly VerifiedTaskAttestationTrustKey[];
  readonly expectedJobSpecHash?: string;
  readonly now?: Date;
}

export type VerifiedTaskAttestationVerificationResult =
  | {
      readonly ok: true;
      readonly attestation: VerifiedTaskAttestation;
      readonly trustedKey: VerifiedTaskAttestationTrustKey;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const ATTESTATION_FIELDS = new Set([
  "id",
  "kind",
  "schemaVersion",
  "environment",
  "issuer",
  "issuerKeyId",
  "orderId",
  "serviceTemplateId",
  "jobSpecHash",
  "canonicalTaskHash",
  "buyerWallet",
  "paymentSignature",
  "nonce",
  "issuedAt",
  "expiresAt",
  "policyVersion",
  "safetyGateVersion",
  "safetyDecisionHash",
  "riskLevel",
  "capabilityProfileHash",
  "templateVersion",
  "approvalId",
  "approvedBy",
  "approvedAt",
  "verifiedTaskHash",
  "verifiedTaskUri",
  "signature",
]);

export function normalizeVerifiedTaskAttestation(
  input: unknown,
  expectedJobSpecHash?: string,
): VerifiedTaskAttestation {
  const raw = parseAttestationInput(input);
  const candidate = raw as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new Error(`verified task attestation field ${key} is not allowed`);
    }
    if (!ATTESTATION_FIELDS.has(key)) {
      throw new Error(`verified task attestation has unsupported field ${key}`);
    }
  }

  const attestation = buildNormalizedAttestation(candidate);
  if (expectedJobSpecHash && attestation.jobSpecHash !== expectedJobSpecHash) {
    throw new Error(
      `verified task attestation jobSpecHash ${attestation.jobSpecHash} does not match ${expectedJobSpecHash}`,
    );
  }

  const verifiedTaskHash = sha256Hex(canonicalJson(buildUnsignedPayload(attestation)));
  if (attestation.verifiedTaskHash !== verifiedTaskHash) {
    throw new Error("verified task attestation hash does not match canonical payload");
  }
  const verifiedTaskUri = `agenc://verified-task/${attestation.environment}/${verifiedTaskHash}`;
  if (attestation.verifiedTaskUri !== verifiedTaskUri) {
    throw new Error("verified task attestation URI does not match verifiedTaskHash");
  }

  return attestation;
}

export function verifyVerifiedTaskAttestation(
  input: VerifiedTaskAttestationVerificationInput,
): VerifiedTaskAttestationVerificationResult {
  let attestation: VerifiedTaskAttestation;
  try {
    attestation = normalizeVerifiedTaskAttestation(
      input.attestation,
      input.expectedJobSpecHash,
    );
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (Date.parse(attestation.expiresAt) <= nowMs) {
    return { ok: false, error: "verified task attestation has expired" };
  }

  const trustedKey = input.trustedKeys.find((key) =>
    key.issuerKeyId === attestation.issuerKeyId &&
    (key.issuer === undefined || key.issuer === attestation.issuer) &&
    (key.environment === undefined || key.environment === attestation.environment)
  );
  if (!trustedKey) {
    return {
      ok: false,
      error: `no trusted public key configured for verified task issuer key ${attestation.issuerKeyId}`,
    };
  }

  try {
    const verified = verifySignatureBytes(
      null,
      Buffer.from(canonicalJson(buildSignedPayload(attestation))),
      createPublicKey(normalizePublicKeyPem(trustedKey.publicKeyPem)),
      Buffer.from(attestation.signature, "base64url"),
    );
    if (!verified) {
      return { ok: false, error: "verified task attestation signature is invalid" };
    }
  } catch (error) {
    return { ok: false, error: `verified task attestation signature failed: ${formatError(error)}` };
  }

  return { ok: true, attestation, trustedKey };
}

export function assertVerifiedTaskAttestation(
  input: VerifiedTaskAttestationVerificationInput,
): VerifiedTaskAttestation {
  const result = verifyVerifiedTaskAttestation(input);
  if (!result.ok) throw new Error(result.error);
  return result.attestation;
}

export function loadVerifiedTaskAttestationTrustKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly VerifiedTaskAttestationTrustKey[] {
  const keys: VerifiedTaskAttestationTrustKey[] = [];
  const rawCollection = env[TRUST_KEYS_ENV]?.trim();
  if (rawCollection) {
    keys.push(...parseTrustKeysCollection(rawCollection));
  }

  const publicKeyPem = env[TRUST_KEY_ENV]?.trim();
  if (publicKeyPem) {
    keys.push({
      issuerKeyId: env[TRUST_KEY_ID_ENV]?.trim() || DEFAULT_TRUST_KEY_ID,
      publicKeyPem,
      issuer: DEFAULT_ISSUER,
      environment: DEFAULT_ENVIRONMENT,
    });
  }

  return keys;
}

export function verifiedTaskTrustKeyFromPublicKey(
  publicKeyPem: string,
  issuerKeyId = DEFAULT_TRUST_KEY_ID,
): VerifiedTaskAttestationTrustKey {
  return {
    issuerKeyId,
    publicKeyPem,
    issuer: DEFAULT_ISSUER,
    environment: DEFAULT_ENVIRONMENT,
  };
}

function parseAttestationInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new Error("verified task attestation must be valid JSON");
    }
    return parseAttestationInput(parsed);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("verified task attestation must be a JSON object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("verified task attestation must be a plain JSON object");
  }
  return input as Record<string, unknown>;
}

function buildNormalizedAttestation(
  candidate: Record<string, unknown>,
): VerifiedTaskAttestation {
  if (candidate.schemaVersion !== ATTESTATION_SCHEMA_VERSION) {
    throw new Error("verified task attestation has unsupported schemaVersion");
  }
  if (candidate.kind !== ATTESTATION_KIND) {
    throw new Error("verified task attestation has invalid kind");
  }
  if (candidate.environment !== DEFAULT_ENVIRONMENT) {
    throw new Error("verified task attestation has unsupported environment");
  }
  if (candidate.issuer !== DEFAULT_ISSUER) {
    throw new Error("verified task attestation has unsupported issuer");
  }

  const riskLevel = requiredString(candidate, "riskLevel", 64);
  if (!RISK_LEVELS.has(riskLevel)) {
    throw new Error("verified task attestation has invalid riskLevel");
  }

  const signature = requiredString(candidate, "signature", 512);
  if (!BASE64URL_RE.test(signature) || Buffer.from(signature, "base64url").length !== 64) {
    throw new Error("verified task attestation has invalid signature encoding");
  }

  const issuedAt = requiredIsoDate(candidate, "issuedAt");
  const expiresAt = requiredIsoDate(candidate, "expiresAt");
  const approvedAt = requiredIsoDate(candidate, "approvedAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("verified task attestation expiresAt must be after issuedAt");
  }

  const attestation: {
    id: string;
    kind: typeof ATTESTATION_KIND;
    schemaVersion: typeof ATTESTATION_SCHEMA_VERSION;
    environment: typeof DEFAULT_ENVIRONMENT;
    issuer: typeof DEFAULT_ISSUER;
    issuerKeyId: string;
    orderId: string;
    serviceTemplateId: string;
    jobSpecHash: string;
    canonicalTaskHash: string;
    buyerWallet?: string;
    paymentSignature?: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    policyVersion: string;
    safetyGateVersion: string;
    safetyDecisionHash: string;
    riskLevel: VerifiedTaskRiskLevel;
    capabilityProfileHash: string;
    templateVersion: string;
    approvalId: string;
    approvedBy: string;
    approvedAt: string;
    verifiedTaskHash: string;
    verifiedTaskUri: string;
    signature: string;
  } = {
    id: requiredString(candidate, "id", 256),
    kind: ATTESTATION_KIND,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    environment: DEFAULT_ENVIRONMENT,
    issuer: DEFAULT_ISSUER,
    issuerKeyId: requiredString(candidate, "issuerKeyId", 256),
    orderId: requiredString(candidate, "orderId", 256),
    serviceTemplateId: requiredString(candidate, "serviceTemplateId", 256),
    jobSpecHash: requiredHash(candidate, "jobSpecHash"),
    canonicalTaskHash: requiredHash(candidate, "canonicalTaskHash"),
    nonce: requiredString(candidate, "nonce", 256),
    issuedAt,
    expiresAt,
    policyVersion: requiredString(candidate, "policyVersion", 256),
    safetyGateVersion: requiredString(candidate, "safetyGateVersion", 256),
    safetyDecisionHash: requiredHash(candidate, "safetyDecisionHash"),
    riskLevel: riskLevel as VerifiedTaskRiskLevel,
    capabilityProfileHash: requiredHash(candidate, "capabilityProfileHash"),
    templateVersion: requiredString(candidate, "templateVersion", 256),
    approvalId: requiredString(candidate, "approvalId", 256),
    approvedBy: requiredString(candidate, "approvedBy", 256),
    approvedAt,
    verifiedTaskHash: requiredHash(candidate, "verifiedTaskHash"),
    verifiedTaskUri: requiredString(candidate, "verifiedTaskUri", 256),
    signature,
  };

  const buyerWallet = optionalString(candidate, "buyerWallet", 256);
  if (buyerWallet !== undefined) attestation.buyerWallet = buyerWallet;
  const paymentSignature = optionalString(candidate, "paymentSignature", 512);
  if (paymentSignature !== undefined) attestation.paymentSignature = paymentSignature;
  return attestation;
}

function buildUnsignedPayload(attestation: VerifiedTaskAttestation): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: attestation.id,
    kind: attestation.kind,
    schemaVersion: attestation.schemaVersion,
    environment: attestation.environment,
    issuer: attestation.issuer,
    issuerKeyId: attestation.issuerKeyId,
    orderId: attestation.orderId,
    serviceTemplateId: attestation.serviceTemplateId,
    jobSpecHash: attestation.jobSpecHash,
    canonicalTaskHash: attestation.canonicalTaskHash,
    nonce: attestation.nonce,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    policyVersion: attestation.policyVersion,
    safetyGateVersion: attestation.safetyGateVersion,
    safetyDecisionHash: attestation.safetyDecisionHash,
    riskLevel: attestation.riskLevel,
    capabilityProfileHash: attestation.capabilityProfileHash,
    templateVersion: attestation.templateVersion,
    approvalId: attestation.approvalId,
    approvedBy: attestation.approvedBy,
    approvedAt: attestation.approvedAt,
  };
  if (attestation.buyerWallet !== undefined) {
    payload.buyerWallet = attestation.buyerWallet;
  }
  if (attestation.paymentSignature !== undefined) {
    payload.paymentSignature = attestation.paymentSignature;
  }
  return payload;
}

function buildSignedPayload(attestation: VerifiedTaskAttestation): Record<string, unknown> {
  return {
    ...buildUnsignedPayload(attestation),
    verifiedTaskHash: attestation.verifiedTaskHash,
    verifiedTaskUri: attestation.verifiedTaskUri,
  };
}

function requiredHash(source: Record<string, unknown>, field: string): string {
  const value = requiredString(source, field, 64);
  if (!HASH_RE.test(value)) {
    throw new Error(`verified task attestation ${field} must be a lowercase sha256 hex string`);
  }
  return value;
}

function requiredIsoDate(source: Record<string, unknown>, field: string): string {
  const value = requiredString(source, field, 128);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`verified task attestation ${field} must be an ISO timestamp`);
  }
  return value;
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`verified task attestation ${field} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`verified task attestation ${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
  maxBytes: number,
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`verified task attestation ${field} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`verified task attestation ${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function parseTrustKeysCollection(input: string): readonly VerifiedTaskAttestationTrustKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error(`${TRUST_KEYS_ENV} must be valid JSON`);
  }

  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) =>
      normalizeTrustKey(entry, `${TRUST_KEYS_ENV}[${index}]`),
    );
  }

  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(
      ([issuerKeyId, publicKeyPem]) =>
        normalizeTrustKey({ issuerKeyId, publicKeyPem }, `${TRUST_KEYS_ENV}.${issuerKeyId}`),
    );
  }

  throw new Error(`${TRUST_KEYS_ENV} must be a JSON array or object`);
}

function normalizeTrustKey(input: unknown, field: string): VerifiedTaskAttestationTrustKey {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${field} must be a JSON object`);
  }
  const record = input as Record<string, unknown>;
  const issuerKeyId = record.issuerKeyId;
  const publicKeyPem = record.publicKeyPem;
  if (typeof issuerKeyId !== "string" || issuerKeyId.trim().length === 0) {
    throw new Error(`${field}.issuerKeyId must be a string`);
  }
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim().length === 0) {
    throw new Error(`${field}.publicKeyPem must be a string`);
  }
  return {
    issuerKeyId: issuerKeyId.trim(),
    publicKeyPem,
    issuer: typeof record.issuer === "string" && record.issuer.trim()
      ? record.issuer.trim()
      : DEFAULT_ISSUER,
    environment: typeof record.environment === "string" && record.environment.trim()
      ? record.environment.trim()
      : DEFAULT_ENVIRONMENT,
  };
}

function normalizePublicKeyPem(value: string): string {
  const trimmed = value.trim().replace(/\\n/g, "\n");
  if (trimmed.includes("BEGIN")) return trimmed;

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.includes("BEGIN")) return decoded;
  } catch {
    // Fall through and let createPublicKey produce the actionable error.
  }

  return trimmed;
}

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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
