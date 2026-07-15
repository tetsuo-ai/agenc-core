export type RuntimeManifestTrustMode = "official" | "explicitHttps" | "explicitLocal";

export interface RuntimeReleaseArtifact {
  readonly platform: string;
  readonly arch: string;
  readonly runtimeVersion: string;
  readonly nodeMajor: number;
  readonly nodeModuleAbi: string;
  readonly nodeApiVersion: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly attestationUrl?: string;
  readonly attestationSha256?: string;
  readonly attestationBytes?: number;
  readonly bins?: { readonly agenc?: string };
  readonly [key: string]: unknown;
}

export interface RuntimeReleaseManifest {
  readonly manifestVersion: 2;
  readonly runtimeVersion: string;
  readonly releaseRepository: string;
  readonly releaseTag: string;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly RuntimeReleaseArtifact[];
  readonly [key: string]: unknown;
}

export const MAX_RUNTIME_MANIFEST_BYTES: number;
export const MAX_RUNTIME_ARTIFACT_BYTES: number;
export const MAX_RUNTIME_ATTESTATION_BYTES: number;
export const OFFICIAL_RELEASE_REPOSITORY: string;
export const OFFICIAL_SOURCE_REPOSITORY: string;
export const OFFICIAL_RELEASE_WORKFLOW: string;
export const RUNTIME_ATTESTATION_POLICY: Readonly<{
  repository: string;
  signerWorkflow: string;
  hostname: string;
  oidcIssuer: string;
  predicateType: string;
}>;
export const PINNED_GITHUB_CLI_VERSION: string;
export const PINNED_GITHUB_CLI_ARTIFACTS: Readonly<Record<string, Readonly<{
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  executable: string;
}>>>;
export const RUNTIME_MANIFEST_TRUST_MODES: readonly RuntimeManifestTrustMode[];

export function canonicalRuntimeAttestationVerificationArgs(options: {
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
}): readonly string[];

export type LocalFileUrlPlatform =
  | "win"
  | "win32"
  | "linux"
  | "darwin"
  | "freebsd"
  | "openbsd"
  | "sunos"
  | "aix";

export function requireRuntimeManifestTrustMode(
  trustMode: unknown,
): RuntimeManifestTrustMode;

export function canonicalRuntimeArtifactName(
  manifest: Pick<RuntimeReleaseManifest, "runtimeVersion">,
  artifact: Pick<
    RuntimeReleaseArtifact,
    "platform" | "arch" | "nodeMajor" | "nodeModuleAbi"
  >,
): string;

export function canonicalLocalFileUrlToPath(
  value: string,
  platform?: LocalFileUrlPlatform,
  label?: string,
): string;

export function validateRuntimeReleaseManifest<T extends RuntimeReleaseManifest>(
  manifest: T,
  options?: {
    readonly trustMode?: RuntimeManifestTrustMode;
    readonly expectedRuntimeVersion?: string;
  },
): T;
