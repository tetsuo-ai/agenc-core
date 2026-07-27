export interface RuntimeArchiveMember {
  readonly path: string;
  readonly type: string;
  readonly bytes: number;
  readonly mode: number;
  readonly contentSha256: string;
  readonly recordSha256: string;
  readonly linkPath?: string;
}

export interface RuntimeArchiveInventory {
  readonly entries: number;
  readonly uncompressedBytes: number;
}

export interface RuntimeArchiveContentInventory extends RuntimeArchiveInventory {
  readonly members: readonly RuntimeArchiveMember[];
}

export interface EmbeddedNodeIdentity {
  readonly schemaVersion: 1;
  readonly nodeVersion: string;
  readonly nodeMajor: number;
  readonly nodeModuleAbi: string;
  readonly nodeApiVersion: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
  readonly license: string;
  readonly licenseSha256: string;
  readonly licenseBytes: number;
  readonly libatomic?: string;
  readonly libatomicSha256?: string;
  readonly libatomicBytes?: number;
  readonly libatomicLicense?: string;
  readonly libatomicLicenseSha256?: string;
  readonly libatomicLicenseBytes?: number;
}

export interface EmbeddedNodeRuntimeArchiveInventory
  extends RuntimeArchiveContentInventory {
  readonly embeddedNodeIdentity: Readonly<EmbeddedNodeIdentity>;
}

export function validateRuntimeArchive(
  path: string,
  platform?: string,
): RuntimeArchiveInventory;

export function runtimeArchiveContentInventory(
  path: string,
  platform?: string,
): RuntimeArchiveContentInventory;

export function validateEmbeddedNodeRuntimeArchive(
  path: string,
  platform?: string,
): EmbeddedNodeRuntimeArchiveInventory;
