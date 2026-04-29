import {
  inferDirectoryTargetsForArtifacts,
  isPathWithinRoot,
} from "./path-normalization.js";

export type ArtifactAccessMode = "read" | "write" | "append" | "mkdir";

export interface ArtifactContract {
  readonly requiredSourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
  readonly targetDirectories: readonly string[];
  readonly targetDirectoryScopes: readonly string[];
}

function isDirectoryScopedTarget(path: string): boolean {
  const normalized = path.replace(/\/+$/g, "");
  const basename = normalized.split("/").pop() ?? normalized;
  return basename.length > 0 && !basename.includes(".");
}

export function buildArtifactContract(params: {
  readonly requiredSourceArtifacts?: readonly string[];
  readonly targetArtifacts?: readonly string[];
}): ArtifactContract {
  const requiredSourceArtifacts = [...(params.requiredSourceArtifacts ?? [])];
  const targetArtifacts = [...(params.targetArtifacts ?? [])];
  return {
    requiredSourceArtifacts,
    targetArtifacts,
    targetDirectories: inferDirectoryTargetsForArtifacts(targetArtifacts),
    targetDirectoryScopes: targetArtifacts.filter(isDirectoryScopedTarget),
  };
}

export function isArtifactAccessAllowed(params: {
  readonly contract: ArtifactContract;
  readonly path: string;
  readonly mode: ArtifactAccessMode;
}): boolean {
  const { contract, path, mode } = params;
  if (mode === "read") {
    if (contract.requiredSourceArtifacts.length === 0) return true;
    return contract.requiredSourceArtifacts.some((artifact) =>
      isPathWithinRoot(path, artifact) || path === artifact
    );
  }

  if (contract.targetArtifacts.some((artifact) => artifact === path)) {
    return true;
  }

  if (contract.targetDirectoryScopes.some((directory) =>
    isPathWithinRoot(path, directory)
  )) {
    return true;
  }

  if (mode === "mkdir") {
    return contract.targetDirectories.some((directory) =>
      directory === path || isPathWithinRoot(path, directory) || isPathWithinRoot(directory, path)
    );
  }
  return false;
}
