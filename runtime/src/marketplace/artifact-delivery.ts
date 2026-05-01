import {
  decodeMarketplaceArtifactSha256FromResultData as decodeArtifactSha256FromResultData,
  encodeMarketplaceArtifactResultData as encodeArtifactResultData,
  hasMarketplaceArtifactDeliveryInput as hasArtifactDeliveryInput,
  prepareMarketplaceArtifactDelivery as prepareArtifactDelivery,
  readMarketplaceArtifactReference as readArtifactReference,
  resolveMarketplaceArtifactReferenceFromResultData as resolveArtifactReferenceFromResultData,
} from "agenc-marketplace-agent-kit/artifacts";

export const MARKETPLACE_ARTIFACT_REFERENCE_KIND = "agenc.marketplace.artifactReference";
export const MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION = 1;
export const MARKETPLACE_ARTIFACT_RESULT_PREFIX = "artifact:sha256:";
export const MARKETPLACE_ARTIFACT_RESULT_BYTES = 64;
export const DEFAULT_MARKETPLACE_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MARKETPLACE_ARTIFACT_STORE_DIR = ".agenc/marketplace-artifacts";

export type MarketplaceArtifactReferenceSource = "file" | "uri";

export interface MarketplaceArtifactReference {
  readonly kind: typeof MARKETPLACE_ARTIFACT_REFERENCE_KIND;
  readonly schemaVersion: typeof MARKETPLACE_ARTIFACT_REFERENCE_SCHEMA_VERSION;
  readonly uri: string;
  readonly sha256: string;
  readonly source: MarketplaceArtifactReferenceSource;
  readonly createdAt: string;
  readonly sizeBytes?: number;
  readonly mediaType?: string;
  readonly fileName?: string;
  readonly localPath?: string;
  readonly durableStorageGuaranteed: false;
}

export interface PrepareMarketplaceArtifactDeliveryInput {
  readonly artifactFile?: string;
  readonly artifactUri?: string;
  readonly artifactSha256?: string;
  readonly artifactMediaType?: string;
  readonly artifactStoreDir?: string;
  readonly artifactMaxBytes?: number;
  readonly now?: Date;
}

export interface PreparedMarketplaceArtifactDelivery {
  readonly reference: MarketplaceArtifactReference;
  readonly proofHash: Uint8Array;
  readonly resultData: Uint8Array;
}

export interface ResolveMarketplaceArtifactReferenceOptions {
  readonly artifactStoreDir?: string;
}

export function encodeMarketplaceArtifactResultData(sha256: string): Uint8Array {
  return encodeArtifactResultData(sha256);
}

export function decodeMarketplaceArtifactSha256FromResultData(
  resultData: Uint8Array,
): string | null {
  return decodeArtifactSha256FromResultData(resultData);
}

export function hasMarketplaceArtifactDeliveryInput(input: {
  readonly artifactFile?: unknown;
  readonly artifactUri?: unknown;
}): boolean {
  return hasArtifactDeliveryInput(input);
}

export async function prepareMarketplaceArtifactDelivery(
  input: PrepareMarketplaceArtifactDeliveryInput,
): Promise<PreparedMarketplaceArtifactDelivery> {
  return prepareArtifactDelivery(input);
}

export async function readMarketplaceArtifactReference(
  sha256: string,
  options: ResolveMarketplaceArtifactReferenceOptions = {},
): Promise<MarketplaceArtifactReference | null> {
  return readArtifactReference(sha256, options);
}

export async function resolveMarketplaceArtifactReferenceFromResultData(
  resultData: Uint8Array,
  options: ResolveMarketplaceArtifactReferenceOptions = {},
): Promise<MarketplaceArtifactReference | null> {
  return resolveArtifactReferenceFromResultData(resultData, options);
}
