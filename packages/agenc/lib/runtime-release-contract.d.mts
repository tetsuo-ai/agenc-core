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
  readonly buildProvenanceUrl?: string;
  readonly buildProvenanceSha256?: string;
  readonly buildProvenanceBytes?: number;
  readonly bins?: {
    readonly agenc?: string;
    readonly node?: string;
    readonly nodeLibrary?: string;
  };
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
export const FROZEN_LEGACY_RUNTIME_VERSION: "0.7.2";
export const MINIMUM_PRIVATE_NODE_RUNTIME_VERSION: "0.11.2";
export const MINIMUM_DUAL_PROVENANCE_RUNTIME_VERSION: "0.13.0";
export const PRIVATE_NODE_BOOTSTRAP_RELEASE_TAG: "agenc-v0.11.2";
export const OFFICIAL_RELEASE_WORKFLOW: string;
export const RUNTIME_ATTESTATION_POLICY: Readonly<{
  repository: string;
  signerWorkflow: string;
  hostname: string;
  oidcIssuer: string;
  predicateType: string;
}>;
export const RUNTIME_BUILD_PROVENANCE_POLICY: Readonly<{
  repository: string;
  signerWorkflow: string;
  hostname: string;
  oidcIssuer: string;
  predicateType: string;
  sourceRef: "refs/heads/main";
}>;
export const PINNED_GITHUB_CLI_VERSION: string;
export const PINNED_GITHUB_CLI_ARTIFACTS: Readonly<Record<string, Readonly<{
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  executable: string;
  executableSha256: string;
  executableBytes: number;
}>>>;
export const RUNTIME_MANIFEST_TRUST_MODES: readonly RuntimeManifestTrustMode[];

export function canonicalRuntimeAttestationVerificationArgs(options: {
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
}): readonly string[];

export function canonicalRuntimeBuildProvenanceVerificationArgs(options: {
  readonly subjectPath: string;
  readonly bundlePath: string;
  readonly sourceCommit: string;
  readonly sourceRef?: "refs/heads/main";
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

export function canonicalRuntimeNodeBin(platform: string): string;

export function canonicalRuntimeNodeLibrary(platform: string): string | undefined;

export function requireSupportedRuntimeVersion(version: string): string;

export function runtimeVersionRequiresDualProvenance(version: string): boolean;

export interface RuntimeReleaseCandidateIdentity {
  readonly workflow: "release-runtime.yml";
  readonly runId: number;
  readonly runAttempt: number;
  readonly runUrl: string;
  readonly phase: "candidate";
  readonly sourceRef: "refs/heads/main";
  readonly evidenceSha256: string;
}

export function validateRuntimeReleaseCandidateIdentity<
  T extends RuntimeReleaseCandidateIdentity,
>(
  value: T | undefined,
  sourceCommit: unknown,
  options?: { readonly required?: boolean },
): T | undefined;

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
