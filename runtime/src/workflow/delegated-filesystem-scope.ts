import {
  isConcreteExecutableEnvelopeRoot,
  isNonExecutableEnvelopePath,
  isWorkspaceAliasPath,
  normalizeArtifactPaths,
  normalizeEnvelopePath,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
} from "./path-normalization.js";

function trimPath(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function canonicalizeDelegatedWorkspaceRoot(params: {
  readonly workspaceRoot?: string | null;
  readonly inheritedWorkspaceRoot?: string | null;
  readonly hostWorkspaceRoot?: string | null;
}): string | undefined {
  const explicitWorkspaceRoot = trimPath(params.workspaceRoot);

  if (!explicitWorkspaceRoot) {
    return undefined;
  }

  if (!isConcreteExecutableEnvelopeRoot(explicitWorkspaceRoot)) {
    const trustedWorkspaceRoot = [
      params.inheritedWorkspaceRoot,
      params.hostWorkspaceRoot,
    ]
      .map((value) =>
        isConcreteExecutableEnvelopeRoot(value) ? normalizeWorkspaceRoot(value) : undefined
      )
      .find((value): value is string => typeof value === "string");
    if (!trustedWorkspaceRoot) {
      return undefined;
    }
    if (
      isWorkspaceAliasPath(explicitWorkspaceRoot) ||
      explicitWorkspaceRoot === "." ||
      explicitWorkspaceRoot === ".." ||
      explicitWorkspaceRoot.startsWith("./") ||
      explicitWorkspaceRoot.startsWith("../")
    ) {
      return normalizeEnvelopePath(explicitWorkspaceRoot, trustedWorkspaceRoot);
    }
    return undefined;
  }

  return normalizeEnvelopePath(explicitWorkspaceRoot);
}

function filterAuthorityPathCandidates(
  paths: readonly (string | undefined | null)[],
  workspaceRoot?: string,
): readonly string[] {
  return paths.filter((path): path is string => {
    const trimmed = trimPath(path);
    if (!trimmed) return false;
    if (isNonExecutableEnvelopePath(trimmed)) return false;
    if (workspaceRoot) return true;
    return isConcreteExecutableEnvelopeRoot(trimmed);
  });
}

interface CanonicalDelegatedFilesystemScope {
  readonly workspaceRoot?: string;
  readonly allowedReadRoots: readonly string[];
  readonly allowedWriteRoots: readonly string[];
  readonly inputArtifacts: readonly string[];
  readonly requiredSourceArtifacts: readonly string[];
  readonly targetArtifacts: readonly string[];
}

export function buildCanonicalDelegatedFilesystemScope(params: {
  readonly workspaceRoot?: string | null;
  readonly inheritedWorkspaceRoot?: string | null;
  readonly hostWorkspaceRoot?: string | null;
  readonly allowedReadRoots?: readonly (string | undefined | null)[];
  readonly allowedWriteRoots?: readonly (string | undefined | null)[];
  readonly inputArtifacts?: readonly (string | undefined | null)[];
  readonly requiredSourceArtifacts?: readonly (string | undefined | null)[];
  readonly targetArtifacts?: readonly (string | undefined | null)[];
}): CanonicalDelegatedFilesystemScope {
  const workspaceRoot = canonicalizeDelegatedWorkspaceRoot({
    workspaceRoot: params.workspaceRoot,
    inheritedWorkspaceRoot: params.inheritedWorkspaceRoot,
    hostWorkspaceRoot: params.hostWorkspaceRoot,
  });
  const allowedReadRoots = filterAuthorityPathCandidates(
    params.allowedReadRoots ?? [],
    workspaceRoot,
  );
  const allowedWriteRoots = filterAuthorityPathCandidates(
    params.allowedWriteRoots ?? [],
    workspaceRoot,
  );
  const inputArtifacts = filterAuthorityPathCandidates(
    params.inputArtifacts ?? [],
    workspaceRoot,
  );
  const requiredSourceArtifacts = filterAuthorityPathCandidates(
    params.requiredSourceArtifacts ?? params.inputArtifacts ?? [],
    workspaceRoot,
  );
  const targetArtifacts = filterAuthorityPathCandidates(
    params.targetArtifacts ?? [],
    workspaceRoot,
  );

  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    allowedReadRoots: normalizeEnvelopeRoots(
      allowedReadRoots,
      workspaceRoot,
    ),
    allowedWriteRoots: normalizeEnvelopeRoots(
      allowedWriteRoots,
      workspaceRoot,
    ),
    inputArtifacts: normalizeArtifactPaths(
      inputArtifacts,
      workspaceRoot,
    ),
    requiredSourceArtifacts: normalizeArtifactPaths(
      requiredSourceArtifacts,
      workspaceRoot,
    ),
    targetArtifacts: normalizeArtifactPaths(
      targetArtifacts,
      workspaceRoot,
    ),
  };
}
