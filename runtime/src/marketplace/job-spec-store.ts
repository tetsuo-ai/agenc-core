import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type MarketplaceJobSpecJsonPrimitive = string | number | boolean | null;
export type MarketplaceJobSpecJsonObject = {
  readonly [key: string]: MarketplaceJobSpecJsonValue;
};
export type MarketplaceJobSpecJsonArray = readonly MarketplaceJobSpecJsonValue[];
export type MarketplaceJobSpecJsonValue =
  | MarketplaceJobSpecJsonPrimitive
  | MarketplaceJobSpecJsonObject
  | MarketplaceJobSpecJsonArray;

const JOB_SPEC_SCHEMA_VERSION = 1;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_REMOTE_SPEC_BYTES = MAX_SPEC_BYTES * 2;
const MAX_JOB_SPEC_URI_BYTES = 256;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 128;
const MAX_ARRAY_ITEMS = 64;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 8;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HASH_RE = /^[a-f0-9]{64}$/;
const TASK_PDA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TASK_ID_RE = /^[a-fA-F0-9]{64}$/;
const ALLOWED_ATTACHMENT_PROTOCOLS = new Set([
  "https:",
  "ipfs:",
  "ar:",
  "arweave:",
]);
const ALLOWED_REMOTE_JOB_SPEC_PROTOCOLS = new Set(["https:"]);

export interface MarketplaceJobAttachment {
  readonly uri: string;
  readonly label?: string;
  readonly sha256?: string;
}

export interface MarketplaceJobSpecPayload {
  readonly schemaVersion: typeof JOB_SPEC_SCHEMA_VERSION;
  readonly kind: "agenc.marketplace.jobSpec";
  readonly title: string;
  readonly shortDescription: string;
  readonly fullDescription: string | null;
  readonly acceptanceCriteria: readonly string[];
  readonly deliverables: readonly string[];
  readonly constraints: MarketplaceJobSpecJsonValue | null;
  readonly attachments: readonly MarketplaceJobAttachment[];
  readonly custom: MarketplaceJobSpecJsonObject | null;
  readonly context: MarketplaceJobSpecJsonObject;
}

export interface MarketplaceJobSpecEnvelope {
  readonly schemaVersion: typeof JOB_SPEC_SCHEMA_VERSION;
  readonly kind: "agenc.marketplace.jobSpecEnvelope";
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly canonicalization: "json-stable-v1";
    readonly payloadHash: string;
    readonly uri: string;
  };
  readonly payload: MarketplaceJobSpecPayload;
}

export interface MarketplaceJobSpecInput {
  readonly description: string;
  readonly jobSpec?: unknown;
  readonly fullDescription?: unknown;
  readonly acceptanceCriteria?: unknown;
  readonly deliverables?: unknown;
  readonly constraints?: unknown;
  readonly attachments?: unknown;
  readonly context?: Record<string, unknown>;
}

export interface MarketplaceJobSpecStoreOptions {
  readonly rootDir?: string;
}

export class MarketplaceJobSpecNotFoundError extends Error {
  readonly label: string;
  readonly path: string;

  constructor(label: string, path: string) {
    super(`No ${label} found: ${path}`);
    this.name = "MarketplaceJobSpecNotFoundError";
    this.label = label;
    this.path = path;
  }
}

export function isMarketplaceJobSpecNotFoundError(
  error: unknown,
): error is MarketplaceJobSpecNotFoundError {
  return error instanceof MarketplaceJobSpecNotFoundError;
}

export function isMarketplaceJobSpecTaskLinkNotFoundError(
  error: unknown,
): error is MarketplaceJobSpecNotFoundError {
  return (
    isMarketplaceJobSpecNotFoundError(error) &&
    error.label.startsWith("marketplace jobSpec task link")
  );
}

export interface StoredMarketplaceJobSpec {
  readonly hash: string;
  readonly uri: string;
  readonly path: string;
  readonly payload: MarketplaceJobSpecPayload;
}

export interface MarketplaceJobSpecTaskLinkInput {
  readonly hash: string;
  readonly uri: string;
  readonly taskPda: string;
  readonly taskId: string;
  readonly transactionSignature: string;
}

export interface MarketplaceJobSpecTaskLink {
  readonly schemaVersion: typeof JOB_SPEC_SCHEMA_VERSION;
  readonly kind: "agenc.marketplace.jobSpecTaskLink";
  readonly taskPda: string;
  readonly taskId: string;
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly transactionSignature: string;
}

export interface MarketplaceJobSpecReference {
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
}

export interface ResolvedMarketplaceJobSpecReference {
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly jobSpecPath: string;
  readonly integrity: MarketplaceJobSpecEnvelope["integrity"];
  readonly envelope: MarketplaceJobSpecEnvelope;
  readonly payload: MarketplaceJobSpecPayload;
}

export interface ResolvedMarketplaceJobSpec {
  readonly taskPda: string;
  readonly taskId: string;
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly jobSpecPath: string;
  readonly jobSpecTaskLinkPath: string;
  readonly transactionSignature: string;
  readonly integrity: MarketplaceJobSpecEnvelope["integrity"];
  readonly envelope: MarketplaceJobSpecEnvelope;
  readonly payload: MarketplaceJobSpecPayload;
  readonly link: MarketplaceJobSpecTaskLink;
}

export interface MarketplaceJobSpecTaskPointer {
  readonly taskPda: string;
  readonly taskId: string;
  readonly jobSpecHash: string;
  readonly jobSpecUri: string;
  readonly jobSpecTaskLinkPath: string;
  readonly transactionSignature: string;
  readonly link: MarketplaceJobSpecTaskLink;
}

export function getDefaultMarketplaceJobSpecStoreDir(): string {
  return join(homedir(), ".agenc", "marketplace", "job-specs");
}

export function hasMarketplaceJobSpecInput(args: Record<string, unknown>): boolean {
  return [
    "jobSpec",
    "fullDescription",
    "acceptanceCriteria",
    "deliverables",
    "constraints",
    "attachments",
  ].some((field) => args[field] !== undefined && args[field] !== null);
}

export async function persistMarketplaceJobSpec(
  input: MarketplaceJobSpecInput,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<StoredMarketplaceJobSpec> {
  const payload = buildMarketplaceJobSpecPayload(input);
  const canonicalPayload = canonicalJson(payload);
  if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_SPEC_BYTES) {
    throw new Error(`jobSpec exceeds ${MAX_SPEC_BYTES} bytes after canonicalization`);
  }

  const hash = sha256Hex(canonicalPayload);
  const uri = `agenc://job-spec/sha256/${hash}`;
  const envelope: MarketplaceJobSpecEnvelope = {
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    kind: "agenc.marketplace.jobSpecEnvelope",
    integrity: {
      algorithm: "sha256",
      canonicalization: "json-stable-v1",
      payloadHash: hash,
      uri,
    },
    payload,
  };
  const serializedEnvelope = `${canonicalJson(envelope)}\n`;
  const rootDir = options.rootDir ?? getDefaultMarketplaceJobSpecStoreDir();
  const objectsDir = join(rootDir, "objects");
  const objectPath = join(objectsDir, `${hash}.json`);

  await mkdir(objectsDir, { recursive: true, mode: 0o700 });
  await writeContentAddressedFile(objectPath, serializedEnvelope, hash);

  return { hash, uri, path: objectPath, payload };
}

export async function linkMarketplaceJobSpecToTask(
  input: MarketplaceJobSpecTaskLinkInput,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<string> {
  if (!HASH_RE.test(input.hash)) {
    throw new Error("jobSpec hash must be a 64-character lowercase sha256 hex string");
  }
  const jobSpecUri = normalizeJobSpecReferenceUri(
    input.uri,
    input.hash,
    "jobSpec uri",
  );
  if (!TASK_PDA_RE.test(input.taskPda)) {
    throw new Error("taskPda is not a valid base58 task address");
  }
  if (!TASK_ID_RE.test(input.taskId)) {
    throw new Error("taskId must be a 32-byte hex string");
  }

  const link: MarketplaceJobSpecTaskLink = {
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    kind: "agenc.marketplace.jobSpecTaskLink",
    taskPda: input.taskPda,
    taskId: input.taskId.toLowerCase(),
    jobSpecHash: input.hash,
    jobSpecUri,
    transactionSignature: normalizeBoundedString(
      input.transactionSignature,
      "transactionSignature",
      256,
    ),
  };
  const rootDir = options.rootDir ?? getDefaultMarketplaceJobSpecStoreDir();
  const linksDir = join(rootDir, "task-links");
  const linkPath = join(linksDir, `${input.taskPda}.json`);
  const serializedLink = `${canonicalJson(link)}\n`;

  await mkdir(linksDir, { recursive: true, mode: 0o700 });
  await writeStableLinkFile(linkPath, serializedLink, input.hash);
  return linkPath;
}

export async function readMarketplaceJobSpecPointerForTask(
  taskPda: string,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<MarketplaceJobSpecTaskPointer | null> {
  const normalizedTaskPda = normalizeTaskPda(taskPda);
  const rootDir = options.rootDir ?? getDefaultMarketplaceJobSpecStoreDir();
  const jobSpecTaskLinkPath = join(
    rootDir,
    "task-links",
    `${normalizedTaskPda}.json`,
  );

  let link: MarketplaceJobSpecTaskLink;
  try {
    link = await readMarketplaceJobSpecTaskLink(
      jobSpecTaskLinkPath,
      normalizedTaskPda,
    );
  } catch (error) {
    if (isMarketplaceJobSpecNotFoundError(error)) return null;
    throw error;
  }

  return {
    taskPda: link.taskPda,
    taskId: link.taskId,
    jobSpecHash: link.jobSpecHash,
    jobSpecUri: link.jobSpecUri,
    jobSpecTaskLinkPath,
    transactionSignature: link.transactionSignature,
    link,
  };
}

export async function resolveMarketplaceJobSpecReference(
  reference: MarketplaceJobSpecReference,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<ResolvedMarketplaceJobSpecReference> {
  if (!HASH_RE.test(reference.jobSpecHash)) {
    throw new Error(
      "jobSpec hash must be a 64-character lowercase sha256 hex string",
    );
  }
  const jobSpecUri = normalizeJobSpecReferenceUri(
    reference.jobSpecUri,
    reference.jobSpecHash,
    "jobSpec uri",
  );
  const expectedUri = canonicalJobSpecUri(reference.jobSpecHash);
  const isRemote = isRemoteJobSpecUri(jobSpecUri);

  const rootDir = options.rootDir ?? getDefaultMarketplaceJobSpecStoreDir();
  const jobSpecPath = isRemote
    ? jobSpecUri
    : join(rootDir, "objects", `${reference.jobSpecHash}.json`);
  const envelope = isRemote
    ? await fetchRemoteMarketplaceJobSpecEnvelope(jobSpecUri, reference.jobSpecHash)
    : await readMarketplaceJobSpecEnvelope(
        jobSpecPath,
        reference.jobSpecHash,
      );

  if (envelope.integrity.payloadHash !== reference.jobSpecHash) {
    throw new Error(
      `jobSpec object hash ${envelope.integrity.payloadHash} does not match requested hash ${reference.jobSpecHash}`,
    );
  }
  if (envelope.integrity.uri !== expectedUri) {
    throw new Error(
      `jobSpec object uri ${envelope.integrity.uri} does not match canonical uri ${expectedUri}`,
    );
  }

  return {
    jobSpecHash: reference.jobSpecHash,
    jobSpecUri,
    jobSpecPath,
    integrity: envelope.integrity,
    envelope,
    payload: envelope.payload,
  };
}

export async function resolveMarketplaceJobSpecForTask(
  taskPda: string,
  options: MarketplaceJobSpecStoreOptions = {},
): Promise<ResolvedMarketplaceJobSpec> {
  const normalizedTaskPda = normalizeTaskPda(taskPda);
  const rootDir = options.rootDir ?? getDefaultMarketplaceJobSpecStoreDir();
  const jobSpecTaskLinkPath = join(
    rootDir,
    "task-links",
    `${normalizedTaskPda}.json`,
  );
  const link = await readMarketplaceJobSpecTaskLink(
    jobSpecTaskLinkPath,
    normalizedTaskPda,
  );
  const resolved = await resolveMarketplaceJobSpecReference(link, options);

  return {
    taskPda: link.taskPda,
    taskId: link.taskId,
    jobSpecHash: link.jobSpecHash,
    jobSpecUri: link.jobSpecUri,
    jobSpecPath: resolved.jobSpecPath,
    jobSpecTaskLinkPath,
    transactionSignature: link.transactionSignature,
    integrity: resolved.integrity,
    envelope: resolved.envelope,
    payload: resolved.payload,
    link,
  };
}

export function verifyMarketplaceJobSpecEnvelope(
  envelope: unknown,
): envelope is MarketplaceJobSpecEnvelope {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return false;
  }
  const candidate = envelope as Partial<MarketplaceJobSpecEnvelope>;
  if (candidate.schemaVersion !== JOB_SPEC_SCHEMA_VERSION) return false;
  if (candidate.kind !== "agenc.marketplace.jobSpecEnvelope") return false;
  if (!candidate.integrity || !candidate.payload) return false;
  const payloadHash = candidate.integrity.payloadHash;
  if (typeof payloadHash !== "string" || !HASH_RE.test(payloadHash)) return false;
  const expectedUri = `agenc://job-spec/sha256/${payloadHash}`;
  if (candidate.integrity.uri !== expectedUri) return false;
  return sha256Hex(canonicalJson(candidate.payload)) === payloadHash;
}

function buildMarketplaceJobSpecPayload(
  input: MarketplaceJobSpecInput,
): MarketplaceJobSpecPayload {
  const title = normalizeBoundedString(input.description, "description", 512);
  const rawObjectSpec = normalizeRawObjectSpec(input.jobSpec);
  const explicitFullDescription = normalizeOptionalString(
    input.fullDescription,
    "fullDescription",
  );
  const fullDescription =
    explicitFullDescription ??
    normalizeOptionalString(input.jobSpec, "jobSpec") ??
    pickOptionalString(rawObjectSpec, ["fullDescription", "description", "body"]);

  const acceptanceCriteria = normalizeStringList(
    input.acceptanceCriteria ?? rawObjectSpec?.acceptanceCriteria,
    "acceptanceCriteria",
  );
  const deliverables = normalizeStringList(
    input.deliverables ?? rawObjectSpec?.deliverables,
    "deliverables",
  );
  const constraintsInput = input.constraints ?? rawObjectSpec?.constraints;
  const attachmentsInput = input.attachments ?? rawObjectSpec?.attachments;
  const custom = rawObjectSpec
    ? sanitizeMarketplaceJobSpecJsonValue(rawObjectSpec, "jobSpec") as MarketplaceJobSpecJsonObject
    : null;
  const context = input.context
    ? sanitizeMarketplaceJobSpecJsonValue(input.context, "context") as MarketplaceJobSpecJsonObject
    : {};

  return {
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    kind: "agenc.marketplace.jobSpec",
    title,
    shortDescription: title,
    fullDescription,
    acceptanceCriteria,
    deliverables,
    constraints:
      constraintsInput === undefined || constraintsInput === null
        ? null
        : sanitizeMarketplaceJobSpecJsonValue(constraintsInput, "constraints"),
    attachments: normalizeAttachments(attachmentsInput),
    custom,
    context,
  };
}

function normalizeRawObjectSpec(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  assertPlainObject(input, "jobSpec");
  return input as Record<string, unknown>;
}

function pickOptionalString(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = normalizeOptionalString(source[key], `jobSpec.${key}`);
    if (value) return value;
  }
  return null;
}

function normalizeOptionalString(input: unknown, field: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") return null;
  const normalized = normalizeBoundedString(input, field, MAX_STRING_BYTES);
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringList(input: unknown, field: string): readonly string[] {
  if (input === undefined || input === null) return [];
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\r?\n/).filter((line) => line.trim().length > 0)
      : [input];

  if (values.length > MAX_ARRAY_ITEMS) {
    throw new Error(`${field} cannot contain more than ${MAX_ARRAY_ITEMS} items`);
  }

  return values.map((value, index) => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`${field}[${index}] must be a string, number, or boolean`);
    }
    return normalizeBoundedString(String(value), `${field}[${index}]`, MAX_STRING_BYTES);
  });
}

function normalizeAttachments(input: unknown): readonly MarketplaceJobAttachment[] {
  if (input === undefined || input === null) return [];
  const values = Array.isArray(input) ? input : [input];
  if (values.length > MAX_ARRAY_ITEMS) {
    throw new Error(`attachments cannot contain more than ${MAX_ARRAY_ITEMS} items`);
  }
  return values.map((value, index) => normalizeAttachment(value, index));
}

function normalizeAttachment(input: unknown, index: number): MarketplaceJobAttachment {
  if (typeof input === "string") {
    return { uri: normalizeAttachmentUri(input, `attachments[${index}]`) };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`attachments[${index}] must be a URL string or object`);
  }
  assertPlainObject(input, `attachments[${index}]`);
  const record = input as Record<string, unknown>;
  const uriInput = record.uri ?? record.url;
  if (typeof uriInput !== "string") {
    throw new Error(`attachments[${index}].uri must be a URL string`);
  }
  const label = normalizeOptionalString(record.label, `attachments[${index}].label`);
  const sha256 = normalizeOptionalString(record.sha256, `attachments[${index}].sha256`);
  const attachment: { uri: string; label?: string; sha256?: string } = {
    uri: normalizeAttachmentUri(uriInput, `attachments[${index}].uri`),
  };
  if (label) attachment.label = label;
  if (sha256) {
    if (!HASH_RE.test(sha256.toLowerCase())) {
      throw new Error(`attachments[${index}].sha256 must be a 64-character hex string`);
    }
    attachment.sha256 = sha256.toLowerCase();
  }
  return attachment;
}

function normalizeAttachmentUri(input: string, field: string): string {
  const uri = normalizeBoundedString(input, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (!ALLOWED_ATTACHMENT_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${field} must use https, ipfs, ar, or arweave protocol`);
  }
  return uri;
}

function sanitizeMarketplaceJobSpecJsonValue(input: unknown, field: string, depth = 0): MarketplaceJobSpecJsonValue {
  if (depth > MAX_DEPTH) {
    throw new Error(`${field} exceeds max object depth ${MAX_DEPTH}`);
  }
  if (input === null) return null;
  if (typeof input === "string") {
    return normalizeBoundedString(input, field, MAX_STRING_BYTES);
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`${field} must be a finite number`);
    }
    return input;
  }
  if (typeof input === "boolean") return input;
  if (Array.isArray(input)) {
    if (input.length > MAX_ARRAY_ITEMS) {
      throw new Error(`${field} cannot contain more than ${MAX_ARRAY_ITEMS} items`);
    }
    return input.map((value, index) =>
      sanitizeMarketplaceJobSpecJsonValue(value, `${field}[${index}]`, depth + 1),
    );
  }
  if (typeof input === "object") {
    assertPlainObject(input, field);
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_KEYS) {
      throw new Error(`${field} cannot contain more than ${MAX_OBJECT_KEYS} keys`);
    }
    const output: Record<string, MarketplaceJobSpecJsonValue> = {};
    for (const [key, value] of entries) {
      const normalizedKey = normalizeObjectKey(key, `${field}.${key}`);
      output[normalizedKey] = sanitizeMarketplaceJobSpecJsonValue(
        value,
        `${field}.${normalizedKey}`,
        depth + 1,
      );
    }
    return output;
  }
  throw new Error(`${field} contains unsupported JSON value`);
}

function assertPlainObject(input: object, field: string): void {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain JSON object`);
  }
}

function normalizeObjectKey(key: string, field: string): string {
  const normalized = normalizeBoundedString(key, field, MAX_KEY_BYTES);
  if (FORBIDDEN_OBJECT_KEYS.has(normalized)) {
    throw new Error(`${field} is not allowed`);
  }
  return normalized;
}

function normalizeBoundedString(input: string, field: string, maxBytes: number): string {
  const normalized = input.trim();
  if (CONTROL_CHARS_RE.test(normalized)) {
    throw new Error(`${field} contains control characters`);
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function normalizeTaskPda(input: string): string {
  const normalized = normalizeBoundedString(input, "taskPda", 64);
  if (!TASK_PDA_RE.test(normalized)) {
    throw new Error("taskPda is not a valid base58 task address");
  }
  return normalized;
}

function canonicalJobSpecUri(hash: string): string {
  return `agenc://job-spec/sha256/${hash}`;
}

function normalizeJobSpecReferenceUri(input: string, hash: string, field: string): string {
  const uri = normalizeBoundedString(input, field, MAX_JOB_SPEC_URI_BYTES);
  const canonicalUri = canonicalJobSpecUri(hash);
  if (uri === canonicalUri) return uri;
  if (uri.startsWith("agenc://job-spec/sha256/")) {
    throw new Error(`${field} does not match hash`);
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${field} must be a canonical agenc URI or absolute https URL`);
  }
  if (!ALLOWED_REMOTE_JOB_SPEC_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${field} must use canonical agenc URI or https protocol`);
  }
  if (!parsed.hostname) {
    throw new Error(`${field} must include a hostname`);
  }
  return uri;
}

function isRemoteJobSpecUri(uri: string): boolean {
  try {
    return ALLOWED_REMOTE_JOB_SPEC_PROTOCOLS.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

async function readMarketplaceJobSpecTaskLink(
  path: string,
  expectedTaskPda: string,
): Promise<MarketplaceJobSpecTaskLink> {
  const parsed = await readJsonFile(
    path,
    `marketplace jobSpec task link for task ${expectedTaskPda}`,
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`marketplace jobSpec task link is not a JSON object: ${path}`);
  }
  const candidate = parsed as Partial<MarketplaceJobSpecTaskLink>;
  if (candidate.schemaVersion !== JOB_SPEC_SCHEMA_VERSION) {
    throw new Error(`marketplace jobSpec task link has unsupported schemaVersion: ${path}`);
  }
  if (candidate.kind !== "agenc.marketplace.jobSpecTaskLink") {
    throw new Error(`marketplace jobSpec task link has invalid kind: ${path}`);
  }
  if (typeof candidate.taskPda !== "string" || !TASK_PDA_RE.test(candidate.taskPda)) {
    throw new Error(`marketplace jobSpec task link has invalid taskPda: ${path}`);
  }
  if (candidate.taskPda !== expectedTaskPda) {
    throw new Error(
      `marketplace jobSpec task link taskPda ${candidate.taskPda} does not match requested task ${expectedTaskPda}`,
    );
  }
  if (typeof candidate.taskId !== "string" || !TASK_ID_RE.test(candidate.taskId)) {
    throw new Error(`marketplace jobSpec task link has invalid taskId: ${path}`);
  }
  const taskId = candidate.taskId.toLowerCase();
  if (typeof candidate.jobSpecHash !== "string" || !HASH_RE.test(candidate.jobSpecHash)) {
    throw new Error(`marketplace jobSpec task link has invalid jobSpecHash: ${path}`);
  }
  if (typeof candidate.jobSpecUri !== "string") {
    throw new Error(`marketplace jobSpec task link has invalid jobSpecUri: ${path}`);
  }
  let jobSpecUri: string;
  try {
    jobSpecUri = normalizeJobSpecReferenceUri(
      candidate.jobSpecUri,
      candidate.jobSpecHash,
      "marketplace jobSpec task link uri",
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${path}`);
  }
  if (typeof candidate.transactionSignature !== "string") {
    throw new Error(`marketplace jobSpec task link has invalid transactionSignature: ${path}`);
  }

  return {
    schemaVersion: JOB_SPEC_SCHEMA_VERSION,
    kind: "agenc.marketplace.jobSpecTaskLink",
    taskPda: candidate.taskPda,
    taskId,
    jobSpecHash: candidate.jobSpecHash,
    jobSpecUri,
    transactionSignature: normalizeBoundedString(
      candidate.transactionSignature,
      "transactionSignature",
      256,
    ),
  };
}

async function readMarketplaceJobSpecEnvelope(
  path: string,
  expectedHash: string,
): Promise<MarketplaceJobSpecEnvelope> {
  const parsed = await readJsonFile(
    path,
    `marketplace jobSpec object for hash ${expectedHash}`,
  );
  if (!verifyMarketplaceJobSpecEnvelope(parsed)) {
    throw new Error(`marketplace jobSpec object failed integrity verification: ${path}`);
  }
  return parsed;
}

async function fetchRemoteMarketplaceJobSpecEnvelope(
  uri: string,
  expectedHash: string,
): Promise<MarketplaceJobSpecEnvelope> {
  if (typeof fetch !== "function") {
    throw new Error("global fetch is not available to resolve remote jobSpec URI");
  }

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(uri, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new Error(
      `failed to fetch remote marketplace jobSpec object ${uri}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `remote marketplace jobSpec object fetch failed with HTTP ${response.status} ${response.statusText}: ${uri}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const contentLengthBytes = Number(contentLength);
    if (Number.isFinite(contentLengthBytes) && contentLengthBytes > MAX_REMOTE_SPEC_BYTES) {
      throw new Error(
        `remote marketplace jobSpec object exceeds ${MAX_REMOTE_SPEC_BYTES} bytes: ${uri}`,
      );
    }
  }

  const content = await response.text();
  if (Buffer.byteLength(content, "utf8") > MAX_REMOTE_SPEC_BYTES) {
    throw new Error(
      `remote marketplace jobSpec object exceeds ${MAX_REMOTE_SPEC_BYTES} bytes: ${uri}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`remote marketplace jobSpec object is not valid JSON: ${uri}`);
  }
  if (!verifyMarketplaceJobSpecEnvelope(parsed)) {
    throw new Error(`remote marketplace jobSpec object failed integrity verification: ${uri}`);
  }
  if (parsed.integrity.payloadHash !== expectedHash) {
    throw new Error(
      `remote marketplace jobSpec object hash ${parsed.integrity.payloadHash} does not match requested hash ${expectedHash}`,
    );
  }
  return parsed;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new MarketplaceJobSpecNotFoundError(label, path);
    }
    throw error;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortMarketplaceJobSpecJsonValue(value));
}

function sortMarketplaceJobSpecJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortMarketplaceJobSpecJsonValue);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortMarketplaceJobSpecJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function writeContentAddressedFile(
  path: string,
  content: string,
  expectedHash: string,
): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const existing = await readFile(path, "utf8");
    const parsed = JSON.parse(existing) as unknown;
    if (!verifyMarketplaceJobSpecEnvelope(parsed)) {
      throw new Error(`existing jobSpec object is invalid or tampered: ${path}`);
    }
    if ((parsed as MarketplaceJobSpecEnvelope).integrity.payloadHash !== expectedHash) {
      throw new Error(`existing jobSpec object hash mismatch: ${path}`);
    }
  }
}

async function writeStableLinkFile(
  path: string,
  content: string,
  expectedHash: string,
): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as Partial<MarketplaceJobSpecTaskLink>;
    const next = JSON.parse(content) as Partial<MarketplaceJobSpecTaskLink>;
    if (existing.jobSpecHash !== expectedHash) {
      throw new Error(`existing task link points to a different jobSpec hash: ${path}`);
    }
    if (existing.taskPda !== next.taskPda || existing.taskId !== next.taskId) {
      throw new Error(`existing task link points to a different task: ${path}`);
    }
    if (canonicalJson(existing) === canonicalJson(next)) return;
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  }
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
