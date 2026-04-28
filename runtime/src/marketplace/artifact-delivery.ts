import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";

export const MARKETPLACE_ARTIFACT_REFERENCE_KIND =
  "agenc.marketplace.artifactReference";
export const MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION = 1;
export const MARKETPLACE_ARTIFACT_RESULT_PREFIX = "artifact:sha256:";
export const MARKETPLACE_ARTIFACT_RESULT_BYTES = 64;
export const DEFAULT_MARKETPLACE_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_ARTIFACT_STORE_DIR = path.join(
  homedir(),
  ".agenc",
  "marketplace-artifacts",
);

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_FILE_NAME_PATTERN = /[^a-zA-Z0-9._-]/g;
const SUPPORTED_ARTIFACT_URI_PROTOCOLS = new Set([
  "ipfs:",
  "ar:",
  "arweave:",
  "https:",
]);

export type MarketplaceArtifactReferenceSource = "file" | "uri";

export interface MarketplaceArtifactReference {
  kind: typeof MARKETPLACE_ARTIFACT_REFERENCE_KIND;
  schemaVersion: typeof MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION;
  uri: string;
  sha256: string;
  source: MarketplaceArtifactReferenceSource;
  createdAt: string;
  sizeBytes?: number;
  mediaType?: string;
  fileName?: string;
  localPath?: string;
}

export interface PrepareMarketplaceArtifactDeliveryInput {
  artifactFile?: string;
  artifactUri?: string;
  artifactSha256?: string;
  artifactMediaType?: string;
  artifactStoreDir?: string;
  artifactMaxBytes?: number;
  now?: Date;
}

export interface PreparedMarketplaceArtifactDelivery {
  reference: MarketplaceArtifactReference;
  proofHash: Uint8Array;
  resultData: Uint8Array;
}

export interface ResolveMarketplaceArtifactReferenceOptions {
  artifactStoreDir?: string;
}

function normalizeSha256Hex(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new Error("artifactSha256 must be a 32-byte lowercase hex SHA-256 digest");
  }
  if (/^0{64}$/.test(normalized)) {
    throw new Error("artifactSha256 cannot be all zeros");
  }
  return normalized;
}

function inferMediaType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function safeFileName(filePath: string): string {
  const raw = path.basename(filePath).replace(SAFE_FILE_NAME_PATTERN, "-");
  return raw.length > 0 ? raw : "artifact";
}

function artifactStoreDir(input?: string): string {
  return input?.trim() || process.env.AGENC_MARKETPLACE_ARTIFACT_STORE_DIR ||
    DEFAULT_MARKETPLACE_ARTIFACT_STORE_DIR;
}

function artifactReferencePath(rootDir: string, sha256: string): string {
  return path.join(rootDir, "references", "sha256", `${sha256}.json`);
}

function artifactBlobPath(rootDir: string, sha256: string, fileName: string): string {
  return path.join(rootDir, "blobs", "sha256", sha256, fileName);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32) {
      throw new Error("invalid length");
    }
    return decoded;
  } catch {
    throw new Error("Invalid artifact resultData SHA-256 encoding");
  }
}

function sha256BytesToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error("SHA-256 digest must be 32 bytes");
  }
  return Buffer.from(bytes).toString("hex");
}

function sha256HexToBytes(sha256: string): Uint8Array {
  return Uint8Array.from(Buffer.from(normalizeSha256Hex(sha256), "hex"));
}

function validateArtifactUri(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.length === 0) {
    throw new Error("artifactUri cannot be empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("artifactUri must be an absolute URI");
  }
  if (!SUPPORTED_ARTIFACT_URI_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      "artifactUri must use ipfs://, ar://, arweave://, or https://",
    );
  }
  return trimmed;
}

async function persistArtifactReference(
  reference: MarketplaceArtifactReference,
  rootDir: string,
): Promise<void> {
  const referencePath = artifactReferencePath(rootDir, reference.sha256);
  await mkdir(path.dirname(referencePath), { recursive: true });
  await writeFile(referencePath, `${JSON.stringify(reference, null, 2)}\n`, "utf8");
}

export function encodeMarketplaceArtifactResultData(sha256: string): Uint8Array {
  const digest = sha256HexToBytes(sha256);
  const encoded = `${MARKETPLACE_ARTIFACT_RESULT_PREFIX}${base64UrlEncode(digest)}`;
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.length > MARKETPLACE_ARTIFACT_RESULT_BYTES) {
    throw new Error("Encoded artifact resultData exceeds 64 bytes");
  }
  const output = new Uint8Array(MARKETPLACE_ARTIFACT_RESULT_BYTES);
  output.set(bytes);
  return output;
}

export function decodeMarketplaceArtifactSha256FromResultData(
  resultData: Uint8Array,
): string | null {
  if (resultData.length !== MARKETPLACE_ARTIFACT_RESULT_BYTES) {
    return null;
  }
  const zeroIndex = resultData.indexOf(0);
  const textBytes = zeroIndex === -1 ? resultData : resultData.subarray(0, zeroIndex);
  const text = new TextDecoder().decode(textBytes);
  if (!text.startsWith(MARKETPLACE_ARTIFACT_RESULT_PREFIX)) {
    return null;
  }
  const encodedDigest = text.slice(MARKETPLACE_ARTIFACT_RESULT_PREFIX.length);
  if (encodedDigest.length === 0) {
    return null;
  }
  try {
    return sha256BytesToHex(base64UrlDecode(encodedDigest));
  } catch {
    return null;
  }
}

export function hasMarketplaceArtifactDeliveryInput(
  input: { artifactFile?: unknown; artifactUri?: unknown },
): boolean {
  return Boolean(
    (typeof input.artifactFile === "string" && input.artifactFile.trim()) ||
      (typeof input.artifactUri === "string" && input.artifactUri.trim()),
  );
}

export async function prepareMarketplaceArtifactDelivery(
  input: PrepareMarketplaceArtifactDeliveryInput,
): Promise<PreparedMarketplaceArtifactDelivery> {
  const hasFile = Boolean(input.artifactFile?.trim());
  const hasUri = Boolean(input.artifactUri?.trim());
  if (hasFile === hasUri) {
    throw new Error("Provide exactly one of artifactFile or artifactUri");
  }

  const rootDir = artifactStoreDir(input.artifactStoreDir);
  const createdAt = (input.now ?? new Date()).toISOString();

  if (hasFile) {
    const sourcePath = path.resolve(input.artifactFile as string);
    const fileStats = await stat(sourcePath);
    if (!fileStats.isFile()) {
      throw new Error("artifactFile must point to a regular file");
    }
    const maxBytes =
      input.artifactMaxBytes ?? DEFAULT_MARKETPLACE_ARTIFACT_MAX_BYTES;
    if (fileStats.size > maxBytes) {
      throw new Error(`artifactFile exceeds ${maxBytes} bytes`);
    }
    const content = await readFile(sourcePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fileName = safeFileName(sourcePath);
    const localPath = artifactBlobPath(rootDir, sha256, fileName);
    await mkdir(path.dirname(localPath), { recursive: true });
    await copyFile(sourcePath, localPath);

    const reference: MarketplaceArtifactReference = {
      kind: MARKETPLACE_ARTIFACT_REFERENCE_KIND,
      schemaVersion: MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION,
      uri: `agenc://artifact/sha256/${sha256}/${encodeURIComponent(fileName)}`,
      sha256,
      source: "file",
      createdAt,
      sizeBytes: fileStats.size,
      mediaType: input.artifactMediaType?.trim() || inferMediaType(sourcePath),
      fileName,
      localPath,
    };
    await persistArtifactReference(reference, rootDir);
    return {
      reference,
      proofHash: sha256HexToBytes(sha256),
      resultData: encodeMarketplaceArtifactResultData(sha256),
    };
  }

  const sha256 = normalizeSha256Hex(input.artifactSha256 ?? "");
  const reference: MarketplaceArtifactReference = {
    kind: MARKETPLACE_ARTIFACT_REFERENCE_KIND,
    schemaVersion: MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION,
    uri: validateArtifactUri(input.artifactUri as string),
    sha256,
    source: "uri",
    createdAt,
    mediaType: input.artifactMediaType?.trim() || undefined,
  };
  await persistArtifactReference(reference, rootDir);
  return {
    reference,
    proofHash: sha256HexToBytes(sha256),
    resultData: encodeMarketplaceArtifactResultData(sha256),
  };
}

export async function readMarketplaceArtifactReference(
  sha256: string,
  options: ResolveMarketplaceArtifactReferenceOptions = {},
): Promise<MarketplaceArtifactReference | null> {
  const normalized = normalizeSha256Hex(sha256);
  const referencePath = artifactReferencePath(
    artifactStoreDir(options.artifactStoreDir),
    normalized,
  );
  try {
    const raw = await readFile(referencePath, "utf8");
    const parsed = JSON.parse(raw) as MarketplaceArtifactReference;
    if (
      parsed.kind !== MARKETPLACE_ARTIFACT_REFERENCE_KIND ||
      parsed.schemaVersion !== MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION ||
      parsed.sha256 !== normalized ||
      typeof parsed.uri !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function resolveMarketplaceArtifactReferenceFromResultData(
  resultData: Uint8Array,
  options: ResolveMarketplaceArtifactReferenceOptions = {},
): Promise<MarketplaceArtifactReference | null> {
  const sha256 = decodeMarketplaceArtifactSha256FromResultData(resultData);
  if (!sha256) {
    return null;
  }
  return readMarketplaceArtifactReference(sha256, options);
}
