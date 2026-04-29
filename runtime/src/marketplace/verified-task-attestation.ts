import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

const VERIFIED_TASK_ATTESTATION_KIND =
  "agenc.marketplace.verifiedTaskAttestation";
const VERIFIED_TASK_METADATA_KIND = "agenc.marketplace.verifiedTask";
const VERIFIED_TASK_REPLAY_MARKER_KIND =
  "agenc.marketplace.verifiedTaskReplayMarker";
const VERIFIED_TASK_SCHEMA_VERSION = 1;
const VERIFIED_TASK_ENVIRONMENT = "devnet";
const VERIFIED_TASK_ISSUER = "agenc-services-storefront";
const HASH_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const ED25519_DER_PUBLIC_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

export interface VerifiedTaskAttestation {
  readonly kind: typeof VERIFIED_TASK_ATTESTATION_KIND;
  readonly schemaVersion: typeof VERIFIED_TASK_SCHEMA_VERSION;
  readonly environment: typeof VERIFIED_TASK_ENVIRONMENT;
  readonly issuer: typeof VERIFIED_TASK_ISSUER;
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
  readonly signature: string;
}

export type VerifiedTaskUnsignedAttestation = Omit<
  VerifiedTaskAttestation,
  "signature"
>;

export interface VerifiedTaskMetadata {
  readonly kind: typeof VERIFIED_TASK_METADATA_KIND;
  readonly schemaVersion: typeof VERIFIED_TASK_SCHEMA_VERSION;
  readonly status: "verified";
  readonly environment: typeof VERIFIED_TASK_ENVIRONMENT;
  readonly issuer: typeof VERIFIED_TASK_ISSUER;
  readonly issuerKeyId: string;
  readonly orderId: string;
  readonly serviceTemplateId: string;
  readonly jobSpecHash: string;
  readonly canonicalTaskHash: string;
  readonly verifiedTaskHash: string;
  readonly verifiedTaskUri: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly buyerWallet?: string;
  readonly paymentSignaturePresent: boolean;
  readonly acceptedAt?: string;
  readonly taskPda?: string;
  readonly taskId?: string;
  readonly transactionSignature?: string | null;
}

export type VerifiedTaskReplayMarkerState = "pending" | "consumed";

export interface VerifiedTaskReplayMarker {
  readonly kind: typeof VERIFIED_TASK_REPLAY_MARKER_KIND;
  readonly schemaVersion: typeof VERIFIED_TASK_SCHEMA_VERSION;
  readonly markerType: "nonce" | "verifiedTaskHash";
  readonly state: VerifiedTaskReplayMarkerState;
  readonly reservedAt: string;
  readonly consumedAt: string | null;
  readonly attestationExpiresAt: string;
  readonly verifiedTask: VerifiedTaskMetadata;
}

export type VerifiedTaskIssuerKeyring = Readonly<Record<string, string>>;

export interface MarketplaceCanonicalTaskInput {
  readonly environment: typeof VERIFIED_TASK_ENVIRONMENT;
  readonly creatorWallet: string;
  readonly creatorAgentPda: string;
  readonly taskDescription: string;
  readonly rewardLamports: string;
  readonly requiredCapabilities: string;
  readonly rewardMint: string | null;
  readonly maxWorkers: number;
  readonly deadline: number;
  readonly taskType: number;
  readonly minReputation: number;
  readonly constraintHash: string | null;
  readonly validationMode: "auto" | "creator-review";
  readonly reviewWindowSecs: number | null;
  readonly jobSpecHash: string;
}

export interface VerifiedTaskAttestationVerificationOptions {
  readonly issuerKeys?: VerifiedTaskIssuerKeyring;
  readonly expectedJobSpecHash: string;
  readonly expectedCanonicalTaskHash: string;
  readonly expectedBuyerWallet?: string | null;
  readonly now?: Date;
  /**
   * Skip the `expiresAt` check. Use ONLY when re-verifying a previously
   * accepted attestation at read time — the attestation's expiry is meant to
   * bound the *acceptance* window, not the lifetime of the resulting verified
   * record. Never skip expiry when accepting a new attestation.
   */
  readonly skipExpiry?: boolean;
}

export interface VerifiedTaskAttestationVerificationResult {
  readonly attestation: VerifiedTaskAttestation;
  readonly unsignedAttestation: VerifiedTaskUnsignedAttestation;
  readonly canonicalUnsignedAttestation: string;
  readonly verifiedTaskHash: string;
  readonly verifiedTaskUri: string;
  readonly issuerPublicKey: string;
}

export interface VerifiedTaskReplayStoreOptions {
  readonly rootDir?: string;
}

export interface VerifiedTaskAcceptanceMetadata {
  readonly acceptedAt?: string;
  readonly taskPda?: string;
  readonly taskId?: string;
  readonly transactionSignature?: string | null;
}

export function getDefaultVerifiedTaskReplayStoreDir(): string {
  return join(homedir(), ".agenc", "marketplace", "verified-task-replay");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalJsonValue(value));
}

export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof input === "string") {
    hash.update(input, "utf8");
  } else {
    hash.update(input);
  }
  return hash.digest("hex");
}

export function buildCanonicalMarketplaceTaskPayload(
  input: MarketplaceCanonicalTaskInput,
): MarketplaceCanonicalTaskInput {
  if (input.environment !== VERIFIED_TASK_ENVIRONMENT) {
    throw new Error("canonical task environment must be devnet");
  }
  assertNonEmptyString(input.creatorWallet, "creatorWallet", 128);
  assertNonEmptyString(input.creatorAgentPda, "creatorAgentPda", 128);
  assertNonEmptyString(input.taskDescription, "taskDescription", 512);
  assertUnsignedDecimalString(input.rewardLamports, "rewardLamports");
  assertUnsignedDecimalString(input.requiredCapabilities, "requiredCapabilities");
  if (input.rewardMint !== null) assertNonEmptyString(input.rewardMint, "rewardMint", 128);
  assertSafeInteger(input.maxWorkers, "maxWorkers");
  assertSafeInteger(input.deadline, "deadline");
  assertSafeInteger(input.taskType, "taskType");
  assertSafeInteger(input.minReputation, "minReputation");
  if (input.constraintHash !== null && !HASH_RE.test(input.constraintHash)) {
    throw new Error("constraintHash must be a lowercase sha256 hex string or null");
  }
  if (input.validationMode !== "auto" && input.validationMode !== "creator-review") {
    throw new Error('validationMode must be "auto" or "creator-review"');
  }
  if (input.reviewWindowSecs !== null) {
    assertSafeInteger(input.reviewWindowSecs, "reviewWindowSecs");
  }
  if (!HASH_RE.test(input.jobSpecHash)) {
    throw new Error("jobSpecHash must be a lowercase sha256 hex string");
  }
  return { ...input };
}

export function computeCanonicalMarketplaceTaskHash(
  input: MarketplaceCanonicalTaskInput,
): string {
  return sha256Hex(canonicalJson(buildCanonicalMarketplaceTaskPayload(input)));
}

/**
 * Parse a JSON-shaped record into a validated `MarketplaceCanonicalTaskInput`.
 * Used at link read time so we can recompute the canonical task hash from the
 * persisted task material rather than trusting `attestation.canonicalTaskHash`
 * to compare against itself.
 */
export function parseMarketplaceCanonicalTaskInput(
  input: unknown,
): MarketplaceCanonicalTaskInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("canonicalTaskInput must be a JSON object");
  }
  assertPlainObject(input, "canonicalTaskInput");
  const record = input as Record<string, unknown>;
  const candidate: MarketplaceCanonicalTaskInput = {
    environment: requireLiteral(
      record.environment,
      VERIFIED_TASK_ENVIRONMENT,
      "canonicalTaskInput.environment",
    ),
    creatorWallet: requireString(
      record.creatorWallet,
      "canonicalTaskInput.creatorWallet",
      128,
    ),
    creatorAgentPda: requireString(
      record.creatorAgentPda,
      "canonicalTaskInput.creatorAgentPda",
      128,
    ),
    taskDescription: requireString(
      record.taskDescription,
      "canonicalTaskInput.taskDescription",
      512,
    ),
    rewardLamports: requireString(
      record.rewardLamports,
      "canonicalTaskInput.rewardLamports",
      64,
    ),
    requiredCapabilities: requireString(
      record.requiredCapabilities,
      "canonicalTaskInput.requiredCapabilities",
      64,
    ),
    rewardMint:
      record.rewardMint === null || record.rewardMint === undefined
        ? null
        : requireString(record.rewardMint, "canonicalTaskInput.rewardMint", 128),
    maxWorkers: requireSafeInteger(
      record.maxWorkers,
      "canonicalTaskInput.maxWorkers",
    ),
    deadline: requireSafeInteger(
      record.deadline,
      "canonicalTaskInput.deadline",
    ),
    taskType: requireSafeInteger(
      record.taskType,
      "canonicalTaskInput.taskType",
    ),
    minReputation: requireSafeInteger(
      record.minReputation,
      "canonicalTaskInput.minReputation",
    ),
    constraintHash:
      record.constraintHash === null || record.constraintHash === undefined
        ? null
        : requireHash(
            record.constraintHash,
            "canonicalTaskInput.constraintHash",
          ),
    validationMode: ((): "auto" | "creator-review" => {
      if (record.validationMode === "auto" || record.validationMode === "creator-review") {
        return record.validationMode;
      }
      throw new Error(
        'canonicalTaskInput.validationMode must be "auto" or "creator-review"',
      );
    })(),
    reviewWindowSecs:
      record.reviewWindowSecs === null || record.reviewWindowSecs === undefined
        ? null
        : requireSafeInteger(
            record.reviewWindowSecs,
            "canonicalTaskInput.reviewWindowSecs",
          ),
    jobSpecHash: requireHash(
      record.jobSpecHash,
      "canonicalTaskInput.jobSpecHash",
    ),
  };
  // Re-run the structural assertions (e.g. unsigned-decimal-string) to catch
  // anything that requireString accepted but the canonical builder rejects.
  return buildCanonicalMarketplaceTaskPayload(candidate);
}

export function unsignedVerifiedTaskAttestation(
  attestation: VerifiedTaskAttestation,
): VerifiedTaskUnsignedAttestation {
  const { signature: _signature, ...unsigned } = attestation;
  return unsigned;
}

export function computeVerifiedTaskHash(
  attestation: VerifiedTaskAttestation,
): string {
  return sha256Hex(canonicalJson(unsignedVerifiedTaskAttestation(attestation)));
}

export function buildVerifiedTaskUri(verifiedTaskHash: string): string {
  if (!HASH_RE.test(verifiedTaskHash)) {
    throw new Error("verifiedTaskHash must be a lowercase sha256 hex string");
  }
  return `agenc://verified-task/devnet/${verifiedTaskHash}`;
}

export function parseVerifiedTaskAttestation(
  input: unknown,
): VerifiedTaskAttestation {
  const parsed = typeof input === "string" ? parseAttestationJson(input) : input;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("verified attestation must be a JSON object");
  }

  assertPlainObject(parsed, "verifiedAttestation");
  const candidate = parsed as Record<string, unknown>;
  const attestation: VerifiedTaskAttestation = {
    kind: requireLiteral(
      candidate.kind,
      VERIFIED_TASK_ATTESTATION_KIND,
      "kind",
    ),
    schemaVersion: requireLiteral(
      candidate.schemaVersion,
      VERIFIED_TASK_SCHEMA_VERSION,
      "schemaVersion",
    ),
    environment: requireLiteral(
      candidate.environment,
      VERIFIED_TASK_ENVIRONMENT,
      "environment",
    ),
    issuer: requireLiteral(candidate.issuer, VERIFIED_TASK_ISSUER, "issuer"),
    issuerKeyId: requireString(candidate.issuerKeyId, "issuerKeyId", 256),
    orderId: requireString(candidate.orderId, "orderId", 256),
    serviceTemplateId: requireString(
      candidate.serviceTemplateId,
      "serviceTemplateId",
      256,
    ),
    jobSpecHash: requireHash(candidate.jobSpecHash, "jobSpecHash"),
    canonicalTaskHash: requireHash(
      candidate.canonicalTaskHash,
      "canonicalTaskHash",
    ),
    nonce: requireString(candidate.nonce, "nonce", 256),
    issuedAt: requireIsoDateString(candidate.issuedAt, "issuedAt"),
    expiresAt: requireIsoDateString(candidate.expiresAt, "expiresAt"),
    signature: requireString(candidate.signature, "signature", 512),
  };

  const buyerWallet = optionalString(candidate.buyerWallet, "buyerWallet", 128);
  if (buyerWallet) {
    try {
      attestationWithOptional(attestation, "buyerWallet", new PublicKey(buyerWallet).toBase58());
    } catch {
      throw new Error("buyerWallet must be a valid base58 public key when provided");
    }
  }
  const paymentSignature = optionalString(
    candidate.paymentSignature,
    "paymentSignature",
    512,
  );
  if (paymentSignature) {
    attestationWithOptional(attestation, "paymentSignature", paymentSignature);
  }

  const issuedAtMs = Date.parse(attestation.issuedAt);
  const expiresAtMs = Date.parse(attestation.expiresAt);
  if (expiresAtMs <= issuedAtMs) {
    throw new Error("expiresAt must be later than issuedAt");
  }

  return attestation;
}

export interface ReadVerifiedTaskAttestationInputOptions {
  /**
   * When true, a string input that is not JSON is treated as a path to a local
   * file containing the attestation. This MUST only be enabled for trusted
   * local entry points (e.g. CLI). Remote channels must leave this disabled to
   * avoid letting untrusted callers ask the runtime to read arbitrary local
   * files.
   */
  readonly allowFilePath?: boolean;
}

export async function readVerifiedTaskAttestationInput(
  input: unknown,
  options: ReadVerifiedTaskAttestationInputOptions = {},
): Promise<VerifiedTaskAttestation | null> {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") return parseVerifiedTaskAttestation(input);

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("{")) {
    return parseVerifiedTaskAttestation(trimmed);
  }
  if (options.allowFilePath !== true) {
    throw new Error(
      "verifiedAttestation must be a JSON object or JSON string; filesystem paths are not allowed in this context",
    );
  }
  const content = await readFile(trimmed, "utf8");
  return parseVerifiedTaskAttestation(content);
}

export function parseVerifiedTaskIssuerKeys(
  input: unknown,
  label = "verified task issuer keys",
): VerifiedTaskIssuerKeyring {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) return {};
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseVerifiedTaskIssuerKeys(JSON.parse(trimmed) as unknown, label);
    }
    const entries = trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
    const keyring: Record<string, string> = {};
    for (const entry of entries) {
      const separator = entry.includes("=") ? "=" : ":";
      const [keyId, publicKey] = entry.split(separator).map((part) => part.trim());
      if (!keyId || !publicKey) {
        throw new Error(`${label} entries must use issuerKeyId=publicKey`);
      }
      keyring[keyId] = normalizePublicKey(publicKey, `${label}.${keyId}`);
    }
    return keyring;
  }
  if (Array.isArray(input)) {
    const keyring: Record<string, string> = {};
    for (const [index, value] of input.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label}[${index}] must be an object`);
      }
      const record = value as Record<string, unknown>;
      const keyId = requireString(record.issuerKeyId ?? record.keyId, `${label}[${index}].issuerKeyId`, 256);
      const publicKey = requireString(record.publicKey, `${label}[${index}].publicKey`, 128);
      keyring[keyId] = normalizePublicKey(publicKey, `${label}.${keyId}`);
    }
    return keyring;
  }
  if (typeof input === "object") {
    assertPlainObject(input, label);
    const keyring: Record<string, string> = {};
    for (const [keyId, publicKey] of Object.entries(input as Record<string, unknown>)) {
      keyring[requireString(keyId, "issuerKeyId", 256)] = normalizePublicKey(
        requireString(publicKey, `${label}.${keyId}`, 128),
        `${label}.${keyId}`,
      );
    }
    return keyring;
  }
  throw new Error(`${label} must be a JSON object, JSON array, or issuerKeyId=publicKey list`);
}

export function loadVerifiedTaskIssuerKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VerifiedTaskIssuerKeyring {
  const value =
    env.AGENC_MARKETPLACE_VERIFIED_TASK_ISSUER_KEYS ??
    env.AGENC_VERIFIED_TASK_ISSUER_KEYS;
  return value ? parseVerifiedTaskIssuerKeys(value) : {};
}

export async function verifyVerifiedTaskAttestation(
  attestationInput: VerifiedTaskAttestation,
  options: VerifiedTaskAttestationVerificationOptions,
): Promise<VerifiedTaskAttestationVerificationResult> {
  const attestation = parseVerifiedTaskAttestation(attestationInput);
  const issuerKeys = options.issuerKeys ?? loadVerifiedTaskIssuerKeysFromEnv();
  const issuerPublicKey = issuerKeys[attestation.issuerKeyId];
  if (!issuerPublicKey) {
    throw new Error(`unknown verified task issuerKeyId: ${attestation.issuerKeyId}`);
  }
  const normalizedIssuerPublicKey = normalizePublicKey(
    issuerPublicKey,
    `issuer key ${attestation.issuerKeyId}`,
  );
  if (attestation.jobSpecHash !== options.expectedJobSpecHash) {
    throw new Error(
      `verified attestation jobSpecHash ${attestation.jobSpecHash} does not match submitted jobSpecHash ${options.expectedJobSpecHash}`,
    );
  }
  if (attestation.canonicalTaskHash !== options.expectedCanonicalTaskHash) {
    throw new Error(
      `verified attestation canonicalTaskHash ${attestation.canonicalTaskHash} does not match submitted task hash ${options.expectedCanonicalTaskHash}`,
    );
  }
  if (
    options.expectedBuyerWallet &&
    attestation.buyerWallet &&
    attestation.buyerWallet !== options.expectedBuyerWallet
  ) {
    throw new Error(
      `verified attestation buyerWallet ${attestation.buyerWallet} does not match signer ${options.expectedBuyerWallet}`,
    );
  }

  if (options.skipExpiry !== true) {
    const nowMs = (options.now ?? new Date()).getTime();
    if (Date.parse(attestation.expiresAt) <= nowMs) {
      throw new Error("verified task attestation is expired");
    }
  }

  const unsignedAttestation = unsignedVerifiedTaskAttestation(attestation);
  const canonicalUnsignedAttestation = canonicalJson(unsignedAttestation);
  const signatureBytes = await decodeSignature(attestation.signature);
  const signatureValid = verifyEd25519Signature(
    normalizedIssuerPublicKey,
    new TextEncoder().encode(canonicalUnsignedAttestation),
    signatureBytes,
  );
  if (!signatureValid) {
    throw new Error("verified task attestation signature verification failed");
  }

  const verifiedTaskHash = sha256Hex(canonicalUnsignedAttestation);
  return {
    attestation,
    unsignedAttestation,
    canonicalUnsignedAttestation,
    verifiedTaskHash,
    verifiedTaskUri: buildVerifiedTaskUri(verifiedTaskHash),
    issuerPublicKey: normalizedIssuerPublicKey,
  };
}

export function buildVerifiedTaskMetadata(
  verification: VerifiedTaskAttestationVerificationResult,
  metadata: VerifiedTaskAcceptanceMetadata = {},
): VerifiedTaskMetadata {
  const { attestation, verifiedTaskHash, verifiedTaskUri } = verification;
  return {
    kind: VERIFIED_TASK_METADATA_KIND,
    schemaVersion: VERIFIED_TASK_SCHEMA_VERSION,
    status: "verified",
    environment: attestation.environment,
    issuer: attestation.issuer,
    issuerKeyId: attestation.issuerKeyId,
    orderId: attestation.orderId,
    serviceTemplateId: attestation.serviceTemplateId,
    jobSpecHash: attestation.jobSpecHash,
    canonicalTaskHash: attestation.canonicalTaskHash,
    verifiedTaskHash,
    verifiedTaskUri,
    nonce: attestation.nonce,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
    ...(attestation.buyerWallet ? { buyerWallet: attestation.buyerWallet } : {}),
    paymentSignaturePresent: Boolean(attestation.paymentSignature),
    ...(metadata.acceptedAt ? { acceptedAt: metadata.acceptedAt } : {}),
    ...(metadata.taskPda ? { taskPda: metadata.taskPda } : {}),
    ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
    ...(metadata.transactionSignature !== undefined
      ? { transactionSignature: metadata.transactionSignature }
      : {}),
  };
}

export function parseVerifiedTaskMetadata(input: unknown): VerifiedTaskMetadata | null {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("verifiedTask metadata must be a JSON object");
  }
  assertPlainObject(input, "verifiedTask");
  const record = input as Record<string, unknown>;
  const metadata: VerifiedTaskMetadata = {
    kind: requireLiteral(record.kind, VERIFIED_TASK_METADATA_KIND, "verifiedTask.kind"),
    schemaVersion: requireLiteral(
      record.schemaVersion,
      VERIFIED_TASK_SCHEMA_VERSION,
      "verifiedTask.schemaVersion",
    ),
    status: requireLiteral(record.status, "verified", "verifiedTask.status"),
    environment: requireLiteral(
      record.environment,
      VERIFIED_TASK_ENVIRONMENT,
      "verifiedTask.environment",
    ),
    issuer: requireLiteral(record.issuer, VERIFIED_TASK_ISSUER, "verifiedTask.issuer"),
    issuerKeyId: requireString(record.issuerKeyId, "verifiedTask.issuerKeyId", 256),
    orderId: requireString(record.orderId, "verifiedTask.orderId", 256),
    serviceTemplateId: requireString(
      record.serviceTemplateId,
      "verifiedTask.serviceTemplateId",
      256,
    ),
    jobSpecHash: requireHash(record.jobSpecHash, "verifiedTask.jobSpecHash"),
    canonicalTaskHash: requireHash(
      record.canonicalTaskHash,
      "verifiedTask.canonicalTaskHash",
    ),
    verifiedTaskHash: requireHash(
      record.verifiedTaskHash,
      "verifiedTask.verifiedTaskHash",
    ),
    verifiedTaskUri: requireVerifiedTaskUri(
      record.verifiedTaskUri,
      "verifiedTask.verifiedTaskUri",
    ),
    nonce: requireString(record.nonce, "verifiedTask.nonce", 256),
    issuedAt: requireIsoDateString(record.issuedAt, "verifiedTask.issuedAt"),
    expiresAt: requireIsoDateString(record.expiresAt, "verifiedTask.expiresAt"),
    paymentSignaturePresent: Boolean(record.paymentSignaturePresent),
  };
  const buyerWallet = optionalString(record.buyerWallet, "verifiedTask.buyerWallet", 128);
  if (buyerWallet) attestationWithOptional(metadata, "buyerWallet", buyerWallet);
  const acceptedAt = optionalIsoDateString(record.acceptedAt, "verifiedTask.acceptedAt");
  if (acceptedAt) attestationWithOptional(metadata, "acceptedAt", acceptedAt);
  const taskPda = optionalString(record.taskPda, "verifiedTask.taskPda", 128);
  if (taskPda) attestationWithOptional(metadata, "taskPda", taskPda);
  const taskId = optionalString(record.taskId, "verifiedTask.taskId", 64);
  if (taskId) attestationWithOptional(metadata, "taskId", taskId);
  if (record.transactionSignature !== undefined && record.transactionSignature !== null) {
    attestationWithOptional(
      metadata,
      "transactionSignature",
      requireString(
        record.transactionSignature,
        "verifiedTask.transactionSignature",
        256,
      ),
    );
  }
  return metadata;
}

export interface VerifiedTaskReplayReservation {
  readonly verification: VerifiedTaskAttestationVerificationResult;
  readonly rootDir: string;
  readonly hashMarkerPath: string;
  readonly nonceMarkerPath: string;
  readonly reservedAt: string;
}

export async function beginVerifiedTaskAttestationReplay(
  verification: VerifiedTaskAttestationVerificationResult,
  options: VerifiedTaskReplayStoreOptions & VerifiedTaskAcceptanceMetadata = {},
): Promise<VerifiedTaskReplayReservation> {
  const rootDir = options.rootDir ?? getDefaultVerifiedTaskReplayStoreDir();
  const paths = replayMarkerPaths(rootDir, verification);
  const reservedAt = options.acceptedAt ?? new Date().toISOString();
  const pendingMetadata = buildVerifiedTaskMetadata(verification, {
    ...options,
    transactionSignature: null,
  });
  const pendingNonce: VerifiedTaskReplayMarker = {
    kind: VERIFIED_TASK_REPLAY_MARKER_KIND,
    schemaVersion: VERIFIED_TASK_SCHEMA_VERSION,
    markerType: "nonce",
    state: "pending",
    reservedAt,
    consumedAt: null,
    attestationExpiresAt: verification.attestation.expiresAt,
    verifiedTask: pendingMetadata,
  };
  const pendingHash: VerifiedTaskReplayMarker = {
    ...pendingNonce,
    markerType: "verifiedTaskHash",
  };

  await mkdir(join(rootDir, "hashes"), { recursive: true, mode: 0o700 });
  await mkdir(join(rootDir, "nonces"), { recursive: true, mode: 0o700 });

  await reserveReplayMarker(paths.nonceMarkerPath, pendingNonce, "nonce");
  try {
    await reserveReplayMarker(paths.hashMarkerPath, pendingHash, "verifiedTaskHash");
  } catch (error) {
    await unlinkIfPendingOwned(paths.nonceMarkerPath, reservedAt);
    throw error;
  }

  return {
    verification,
    rootDir,
    hashMarkerPath: paths.hashMarkerPath,
    nonceMarkerPath: paths.nonceMarkerPath,
    reservedAt,
  };
}

export async function finalizeVerifiedTaskAttestationReplay(
  reservation: VerifiedTaskReplayReservation,
  options: VerifiedTaskAcceptanceMetadata = {},
): Promise<void> {
  if (
    options.transactionSignature === undefined ||
    options.transactionSignature === null ||
    options.transactionSignature.trim().length === 0
  ) {
    throw new Error(
      "verified task replay finalization requires a non-empty transactionSignature",
    );
  }
  const consumedAt = options.acceptedAt ?? new Date().toISOString();
  const finalMetadata = buildVerifiedTaskMetadata(reservation.verification, {
    ...options,
    acceptedAt: options.acceptedAt ?? reservation.reservedAt,
  });
  const baseMarker = {
    kind: VERIFIED_TASK_REPLAY_MARKER_KIND,
    schemaVersion: VERIFIED_TASK_SCHEMA_VERSION,
    state: "consumed",
    reservedAt: reservation.reservedAt,
    consumedAt,
    attestationExpiresAt: reservation.verification.attestation.expiresAt,
    verifiedTask: finalMetadata,
  } as const;
  const consumedNonce: VerifiedTaskReplayMarker = {
    ...baseMarker,
    markerType: "nonce",
  };
  const consumedHash: VerifiedTaskReplayMarker = {
    ...baseMarker,
    markerType: "verifiedTaskHash",
  };

  await replacePendingMarker(
    reservation.nonceMarkerPath,
    consumedNonce,
    reservation.reservedAt,
  );
  await replacePendingMarker(
    reservation.hashMarkerPath,
    consumedHash,
    reservation.reservedAt,
  );
}

export async function releaseVerifiedTaskAttestationReplay(
  reservation: VerifiedTaskReplayReservation,
): Promise<void> {
  await unlinkIfPendingOwned(reservation.hashMarkerPath, reservation.reservedAt);
  await unlinkIfPendingOwned(reservation.nonceMarkerPath, reservation.reservedAt);
}

function replayMarkerPaths(
  rootDir: string,
  verification: VerifiedTaskAttestationVerificationResult,
): { readonly hashMarkerPath: string; readonly nonceMarkerPath: string } {
  const nonceKey = sha256Hex(
    `${verification.attestation.issuerKeyId}\0${verification.attestation.nonce}`,
  );
  return {
    hashMarkerPath: join(rootDir, "hashes", `${verification.verifiedTaskHash}.json`),
    nonceMarkerPath: join(rootDir, "nonces", `${nonceKey}.json`),
  };
}

async function reserveReplayMarker(
  path: string,
  marker: VerifiedTaskReplayMarker,
  label: "nonce" | "verifiedTaskHash",
  now: Date = new Date(),
): Promise<void> {
  try {
    await writeReplayMarker(path, marker, "wx");
    return;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  const existing = await readReplayMarker(path);
  if (existing.state === "consumed") {
    throw new Error(
      `verified task replay rejected: ${label} was already consumed`,
    );
  }
  if (Date.parse(existing.attestationExpiresAt) > now.getTime()) {
    throw new Error(
      `verified task replay rejected: ${label} reservation is in flight`,
    );
  }
  await writeReplayMarker(path, marker, "w");
}

async function replacePendingMarker(
  path: string,
  marker: VerifiedTaskReplayMarker,
  expectedReservedAt: string,
): Promise<void> {
  let existing: VerifiedTaskReplayMarker;
  try {
    existing = await readReplayMarker(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(
        `verified task replay marker missing: ${marker.markerType}`,
      );
    }
    throw error;
  }
  if (existing.state === "consumed") {
    throw new Error(
      `verified task replay finalize rejected: ${marker.markerType} was already consumed`,
    );
  }
  if (existing.reservedAt !== expectedReservedAt) {
    throw new Error(
      `verified task replay finalize rejected: ${marker.markerType} reservation does not match`,
    );
  }
  const tempPath = `${path}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${canonicalJson(marker)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function unlinkIfPendingOwned(
  path: string,
  expectedReservedAt: string,
): Promise<void> {
  let existing: VerifiedTaskReplayMarker;
  try {
    existing = await readReplayMarker(path);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  if (existing.state !== "pending") return;
  if (existing.reservedAt !== expectedReservedAt) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function readReplayMarker(path: string): Promise<VerifiedTaskReplayMarker> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return parseReplayMarker(parsed, path);
}

function parseReplayMarker(
  candidate: Record<string, unknown>,
  path: string,
): VerifiedTaskReplayMarker {
  if (candidate.kind !== VERIFIED_TASK_REPLAY_MARKER_KIND) {
    throw new Error(`replay marker has invalid kind: ${path}`);
  }
  if (candidate.schemaVersion !== VERIFIED_TASK_SCHEMA_VERSION) {
    throw new Error(`replay marker has unsupported schemaVersion: ${path}`);
  }
  const markerType = candidate.markerType;
  if (markerType !== "nonce" && markerType !== "verifiedTaskHash") {
    throw new Error(`replay marker has invalid markerType: ${path}`);
  }
  const state = candidate.state;
  if (state !== "pending" && state !== "consumed") {
    throw new Error(`replay marker has invalid state: ${path}`);
  }
  const reservedAt = requireIsoDateString(candidate.reservedAt, "reservedAt");
  const attestationExpiresAt = requireIsoDateString(
    candidate.attestationExpiresAt,
    "attestationExpiresAt",
  );
  const consumedAt =
    state === "consumed"
      ? requireIsoDateString(candidate.consumedAt, "consumedAt")
      : candidate.consumedAt === null || candidate.consumedAt === undefined
        ? null
        : (() => {
            throw new Error(`replay marker has invalid consumedAt: ${path}`);
          })();
  const verifiedTask = parseVerifiedTaskMetadata(candidate.verifiedTask);
  if (!verifiedTask) {
    throw new Error(`replay marker has invalid verifiedTask: ${path}`);
  }
  return {
    kind: VERIFIED_TASK_REPLAY_MARKER_KIND,
    schemaVersion: VERIFIED_TASK_SCHEMA_VERSION,
    markerType,
    state,
    reservedAt,
    consumedAt,
    attestationExpiresAt,
    verifiedTask,
  };
}

async function writeReplayMarker(
  path: string,
  marker: VerifiedTaskReplayMarker,
  flag: "wx" | "w",
): Promise<void> {
  await writeFile(path, `${canonicalJson(marker)}\n`, {
    encoding: "utf8",
    flag,
    mode: 0o600,
  });
}

async function decodeSignature(signature: string): Promise<Uint8Array> {
  const normalized = signature.trim();
  if (/^[0-9a-f]{128}$/i.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }

  try {
    const base64 = Buffer.from(normalized, "base64");
    if (base64.length === 64) return base64;
  } catch {
    // Fall through to base58.
  }

  try {
    const bs58 = await import("bs58");
    const decoded = bs58.default.decode(normalized);
    if (decoded.length === 64) return decoded;
  } catch {
    // Fall through to the shared error below.
  }

  throw new Error("signature must be a 64-byte Ed25519 signature encoded as base58, base64, or hex");
}

function verifyEd25519Signature(
  publicKey: string,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  try {
    const derKey = createPublicKey({
      key: Buffer.concat([
        ED25519_DER_PUBLIC_PREFIX,
        new PublicKey(publicKey).toBytes(),
      ]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload), derKey, Buffer.from(signature));
  } catch {
    return false;
  }
}

function parseAttestationJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("verified attestation is not valid JSON");
  }
}

function sortCanonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalJsonValue);
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("canonical JSON cannot encode non-finite numbers");
    }
    return value;
  }
  assertPlainObject(value, "canonical JSON object");
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new Error(`canonical JSON object key ${key} is not allowed`);
    }
    sorted[key] = sortCanonicalJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) {
    throw new Error(`${field} must be ${String(expected)}`);
  }
  return expected;
}

function requireString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return assertNonEmptyString(value, field, maxBytes);
}

function optionalString(
  value: unknown,
  field: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  return assertNonEmptyString(value, field, maxBytes);
}

function assertNonEmptyString(value: string, field: string, maxBytes: number): string {
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new Error(`${field} contains control characters`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function assertUnsignedDecimalString(value: string, field: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be an unsigned integer string`);
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`${field} must be a number`);
  }
  assertSafeInteger(value, field);
  return value;
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field, 64);
  if (!HASH_RE.test(hash)) {
    throw new Error(`${field} must be a lowercase sha256 hex string`);
  }
  return hash;
}

function requireIsoDateString(value: unknown, field: string): string {
  const text = requireString(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${field} must be a valid ISO date string`);
  }
  return text;
}

function optionalIsoDateString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoDateString(value, field);
}

function requireVerifiedTaskUri(value: unknown, field: string): string {
  const uri = requireString(value, field, 128);
  if (!uri.startsWith("agenc://verified-task/devnet/")) {
    throw new Error(`${field} must use agenc://verified-task/devnet/{hash}`);
  }
  const hash = uri.slice("agenc://verified-task/devnet/".length);
  if (!HASH_RE.test(hash)) {
    throw new Error(`${field} must end with a lowercase sha256 hex string`);
  }
  return uri;
}

function normalizePublicKey(input: string, field: string): string {
  try {
    return new PublicKey(input).toBase58();
  } catch {
    throw new Error(`${field} must be a valid base58 Ed25519 public key`);
  }
}

function assertPlainObject(input: object, field: string): void {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain JSON object`);
  }
}

function attestationWithOptional(
  target: object,
  key: string,
  value: unknown,
): void {
  (target as Record<string, unknown>)[key] = value;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
