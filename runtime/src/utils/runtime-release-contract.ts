// Runtime-facing typed bridge to the launcher's canonical release trust policy.

export {
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_ATTESTATION_BYTES,
  MAX_RUNTIME_MANIFEST_BYTES,
  OFFICIAL_RELEASE_WORKFLOW,
  OFFICIAL_RELEASE_REPOSITORY,
  OFFICIAL_SOURCE_REPOSITORY,
  PINNED_GITHUB_CLI_ARTIFACTS,
  PINNED_GITHUB_CLI_VERSION,
  RUNTIME_ATTESTATION_POLICY,
  RUNTIME_MANIFEST_TRUST_MODES,
  canonicalRuntimeAttestationVerificationArgs,
  canonicalLocalFileUrlToPath,
  canonicalRuntimeArtifactName,
  requireRuntimeManifestTrustMode,
  validateRuntimeReleaseManifest,
  type RuntimeManifestTrustMode,
  type RuntimeReleaseArtifact,
  type RuntimeReleaseManifest,
} from "../../../packages/agenc/lib/runtime-release-contract.mjs";
