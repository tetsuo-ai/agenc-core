import {
  createExecutionEnvelope,
  isCompatibilityExecutionEnvelope,
  type ExecutionApprovalProfile,
  type ExecutionEffectClass,
  type ExecutionEnvelope,
  type ExecutionFallbackPolicy,
  type ExecutionResumePolicy,
  type ExecutionStepKind,
  type ExecutionVerificationMode,
  type WorkflowArtifactRelation,
  type WorkflowStepRole,
} from "../workflow/execution-envelope.js";
import type { ImplementationCompletionContract } from "../workflow/completion-contract.js";
import { migrateExecutionEnvelope } from "../workflow/migrations.js";
import { buildCanonicalDelegatedFilesystemScope } from "../workflow/delegated-filesystem-scope.js";
import {
  isConcreteExecutableEnvelopeRoot,
  isPathWithinAnyRoot,
  isPathWithinRoot,
  normalizeArtifactPaths,
  normalizeEnvelopeRoots,
  normalizeWorkspaceRoot,
} from "../workflow/path-normalization.js";

export type DelegationExecutionContext = ExecutionEnvelope;

export {
  createExecutionEnvelope as createDelegationExecutionContext,
};

const LEGACY_DELEGATED_SCOPE_REQUIREMENT_RE =
  /^(?:cwd|working(?:[_ -]?directory))\s*(?:=|:)\s*/i;

export function isLegacyDelegatedScopeRequirement(
  value: string | undefined | null,
): boolean {
  if (typeof value !== "string") return false;
  return LEGACY_DELEGATED_SCOPE_REQUIREMENT_RE.test(value.trim());
}

export function sanitizeDelegationContextRequirements(
  contextRequirements?: readonly (string | undefined | null)[],
): readonly string[] {
  const sanitized: string[] = [];
  for (const rawValue of contextRequirements ?? []) {
    if (typeof rawValue !== "string") continue;
    const normalized = rawValue.trim();
    if (
      normalized.length === 0 ||
      isLegacyDelegatedScopeRequirement(normalized) ||
      sanitized.includes(normalized)
    ) {
      continue;
    }
    sanitized.push(normalized);
  }
  return sanitized;
}

export function extractLegacyDelegatedWorkspaceRoot(
  contextRequirements?: readonly (string | undefined | null)[],
): string | undefined {
  return (contextRequirements ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .find((value) => isLegacyDelegatedScopeRequirement(value))
    ?.replace(LEGACY_DELEGATED_SCOPE_REQUIREMENT_RE, "")
    .trim();
}

function isConcreteHostPath(path: string | undefined | null): boolean {
  if (typeof path !== "string") return false;
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed === "/workspace" || trimmed.startsWith("/workspace/")) {
    return false;
  }
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

function legacyWorkspaceRootNeedsConcreteFallback(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return true;
  if (trimmed === "/workspace" || trimmed.startsWith("/workspace/")) {
    return true;
  }
  if (trimmed === "." || trimmed === "..") {
    return true;
  }
  return !(
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

export function coerceDelegationExecutionContext(
  value: unknown,
): DelegationExecutionContext | undefined {
  return migrateExecutionEnvelope(value).value;
}

export function buildDelegationExecutionContext(params: {
  readonly workspaceRoot?: string | null;
  readonly inheritedWorkspaceRoot?: string | null;
  readonly hostWorkspaceRoot?: string | null;
  readonly allowedReadRoots?: readonly (string | undefined | null)[];
  readonly allowedWriteRoots?: readonly (string | undefined | null)[];
  readonly allowedTools?: readonly (string | undefined | null)[];
  readonly inputArtifacts?: readonly (string | undefined | null)[];
  readonly targetArtifacts?: readonly (string | undefined | null)[];
  readonly requiredSourceArtifacts?: readonly (string | undefined | null)[];
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly role?: WorkflowStepRole;
  readonly artifactRelations?: readonly WorkflowArtifactRelation[];
  readonly completionContract?: ImplementationCompletionContract;
  readonly fallbackPolicy?: ExecutionFallbackPolicy;
  readonly resumePolicy?: ExecutionResumePolicy;
  readonly approvalProfile?: ExecutionApprovalProfile;
}): DelegationExecutionContext | undefined {
  const canonicalScope = buildCanonicalDelegatedFilesystemScope({
    workspaceRoot: params.workspaceRoot,
    inheritedWorkspaceRoot: params.inheritedWorkspaceRoot,
    hostWorkspaceRoot: params.hostWorkspaceRoot,
    allowedReadRoots: params.allowedReadRoots,
    allowedWriteRoots: params.allowedWriteRoots,
    inputArtifacts: params.inputArtifacts,
    requiredSourceArtifacts: params.requiredSourceArtifacts,
    targetArtifacts: params.targetArtifacts,
  });

  return createExecutionEnvelope({
    workspaceRoot: canonicalScope.workspaceRoot,
    allowedReadRoots: canonicalScope.allowedReadRoots,
    allowedWriteRoots: canonicalScope.allowedWriteRoots,
    allowedTools: params.allowedTools,
    inputArtifacts: canonicalScope.inputArtifacts,
    targetArtifacts: canonicalScope.targetArtifacts,
    requiredSourceArtifacts: canonicalScope.requiredSourceArtifacts,
    effectClass: params.effectClass,
    verificationMode: params.verificationMode,
    stepKind: params.stepKind,
    role: params.role,
    artifactRelations: params.artifactRelations,
    completionContract: params.completionContract,
    fallbackPolicy: params.fallbackPolicy,
    resumePolicy: params.resumePolicy,
    approvalProfile: params.approvalProfile,
  });
}

/**
 * Reader-only compatibility adapter for historical planner/eval payloads that
 * still express the workspace root through `context_requirements`.
 *
 * This helper is intentionally off the live direct adapter path. It exists only
 * for bounded migration/eval readers and must be removed once those readers no
 * longer need legacy fixture coverage.
 */
export function buildLegacyDelegationExecutionContext(params: {
  readonly contextRequirements?: readonly (string | undefined | null)[];
  readonly inheritedWorkspaceRoot?: string | null;
  readonly hostWorkspaceRoot?: string | null;
  readonly allowedReadRoots?: readonly (string | undefined | null)[];
  readonly allowedWriteRoots?: readonly (string | undefined | null)[];
  readonly allowedTools?: readonly (string | undefined | null)[];
  readonly inputArtifacts?: readonly (string | undefined | null)[];
  readonly targetArtifacts?: readonly (string | undefined | null)[];
  readonly requiredSourceArtifacts?: readonly (string | undefined | null)[];
  readonly effectClass?: ExecutionEffectClass;
  readonly verificationMode?: ExecutionVerificationMode;
  readonly stepKind?: ExecutionStepKind;
  readonly completionContract?: ImplementationCompletionContract;
  readonly fallbackPolicy?: ExecutionFallbackPolicy;
  readonly resumePolicy?: ExecutionResumePolicy;
  readonly approvalProfile?: ExecutionApprovalProfile;
}): DelegationExecutionContext | undefined {
  const legacyWorkspaceRoot = extractLegacyDelegatedWorkspaceRoot(
    params.contextRequirements,
  );
  if (!legacyWorkspaceRoot) {
    return undefined;
  }
  if (
    legacyWorkspaceRootNeedsConcreteFallback(legacyWorkspaceRoot) &&
    !isConcreteHostPath(params.inheritedWorkspaceRoot) &&
    !isConcreteHostPath(params.hostWorkspaceRoot)
  ) {
    return undefined;
  }
  const canonicalScope = buildCanonicalDelegatedFilesystemScope({
    workspaceRoot: legacyWorkspaceRoot,
    inheritedWorkspaceRoot: params.inheritedWorkspaceRoot,
    hostWorkspaceRoot: params.hostWorkspaceRoot,
    allowedReadRoots: params.allowedReadRoots,
    allowedWriteRoots: params.allowedWriteRoots,
    inputArtifacts: params.inputArtifacts,
    requiredSourceArtifacts: params.requiredSourceArtifacts,
    targetArtifacts: params.targetArtifacts,
  });
  return createExecutionEnvelope({
    workspaceRoot: canonicalScope.workspaceRoot,
    allowedReadRoots: canonicalScope.allowedReadRoots,
    allowedWriteRoots: canonicalScope.allowedWriteRoots,
    allowedTools: params.allowedTools,
    inputArtifacts: canonicalScope.inputArtifacts,
    targetArtifacts: canonicalScope.targetArtifacts,
    requiredSourceArtifacts: canonicalScope.requiredSourceArtifacts,
    effectClass: params.effectClass,
    verificationMode: params.verificationMode,
    stepKind: params.stepKind,
    completionContract: params.completionContract,
    fallbackPolicy: params.fallbackPolicy,
    resumePolicy: params.resumePolicy,
    approvalProfile: params.approvalProfile,
    compatibilitySource: "legacy_context_requirements",
  });
}

export function canonicalizeDelegationExecutionContext(
  context: DelegationExecutionContext | undefined,
  params: {
    readonly inheritedWorkspaceRoot?: string | null;
    readonly hostWorkspaceRoot?: string | null;
  } = {},
): DelegationExecutionContext | undefined {
  if (!context || isCompatibilityExecutionEnvelope(context)) {
    return undefined;
  }
  return buildDelegationExecutionContext({
    workspaceRoot: context.workspaceRoot,
    inheritedWorkspaceRoot: params.inheritedWorkspaceRoot,
    hostWorkspaceRoot: params.hostWorkspaceRoot,
    allowedReadRoots: context.allowedReadRoots,
    allowedWriteRoots: context.allowedWriteRoots,
    allowedTools: context.allowedTools,
    inputArtifacts: context.inputArtifacts,
    targetArtifacts: context.targetArtifacts,
    requiredSourceArtifacts: context.requiredSourceArtifacts,
    effectClass: context.effectClass,
    verificationMode: context.verificationMode,
    stepKind: context.stepKind,
    completionContract: context.completionContract,
    fallbackPolicy: context.fallbackPolicy,
    resumePolicy: context.resumePolicy,
    approvalProfile: context.approvalProfile,
  });
}

export type DelegatedExecutionEnvelopeDerivationSource =
  | "direct_live_path"
  | "internal_planner_path";

export type DelegatedExecutionEnvelopeDerivationIssueCode =
  | "missing_parent_workspace_authority"
  | "workspace_root_outside_parent_workspace"
  | "read_root_outside_parent_workspace"
  | "write_root_outside_parent_workspace"
  | "input_artifact_outside_parent_workspace"
  | "required_source_outside_parent_workspace"
  | "target_outside_parent_workspace";

export interface DelegatedExecutionEnvelopeDerivationIssue {
  readonly code: DelegatedExecutionEnvelopeDerivationIssueCode;
  readonly message: string;
  readonly path?: string;
}

export type DelegatedExecutionEnvelopeDerivationResult =
  | {
      readonly ok: true;
      readonly executionContext?: DelegationExecutionContext;
      readonly workingDirectory?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly issues: readonly DelegatedExecutionEnvelopeDerivationIssue[];
    };

function buildDerivationFailure(
  issue: DelegatedExecutionEnvelopeDerivationIssue,
): DelegatedExecutionEnvelopeDerivationResult {
  return {
    ok: false,
    error: issue.message,
    issues: [issue],
  };
}

function buildMissingParentWorkspaceAuthorityFailure(
  source: DelegatedExecutionEnvelopeDerivationSource,
): DelegatedExecutionEnvelopeDerivationResult {
  return buildDerivationFailure({
    code: "missing_parent_workspace_authority",
    message:
      source === "internal_planner_path"
        ? "Delegated local-file work must have a canonical workspace root before child execution."
        : "Direct execute_with_agent local-file work requires a trusted parent workspace root before child execution.",
  });
}

function normalizeParentRoots(
  roots: readonly (string | undefined | null)[] | undefined,
  parentWorkspaceRoot: string,
): readonly string[] {
  const normalized = normalizeEnvelopeRoots(roots ?? [], parentWorkspaceRoot);
  const filtered = normalized.filter((path) =>
    isPathWithinRoot(path, parentWorkspaceRoot)
  );
  return filtered.length > 0 ? filtered : [parentWorkspaceRoot];
}

function normalizeRequestedRoots(
  roots: readonly string[] | undefined,
  childWorkspaceRoot: string,
): readonly string[] | undefined {
  if (!roots || roots.length === 0) return undefined;
  return normalizeEnvelopeRoots(roots, childWorkspaceRoot);
}

function normalizeRequestedArtifacts(
  paths: readonly string[] | undefined,
  childWorkspaceRoot: string,
): readonly string[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  return normalizeArtifactPaths(paths, childWorkspaceRoot);
}

export function deriveDelegatedExecutionEnvelopeFromParent(params: {
  readonly parentWorkspaceRoot?: string | null;
  readonly parentAllowedReadRoots?: readonly (string | undefined | null)[];
  readonly parentAllowedWriteRoots?: readonly (string | undefined | null)[];
  readonly requestedExecutionContext?: DelegationExecutionContext;
  readonly requiresStructuredExecutionContext: boolean;
  readonly source: DelegatedExecutionEnvelopeDerivationSource;
}): DelegatedExecutionEnvelopeDerivationResult {
  if (!params.requiresStructuredExecutionContext) {
    return { ok: true };
  }

  const rawRequestedWorkspaceRoot =
    params.requestedExecutionContext?.workspaceRoot;
  if (
    typeof rawRequestedWorkspaceRoot === "string" &&
    rawRequestedWorkspaceRoot.trim().length > 0 &&
    !isConcreteExecutableEnvelopeRoot(rawRequestedWorkspaceRoot)
  ) {
    return buildMissingParentWorkspaceAuthorityFailure(params.source);
  }

  const runtimeOwnedPlannerWorkspaceRoot =
    params.source === "internal_planner_path" &&
      params.requestedExecutionContext
      ? normalizeWorkspaceRoot(rawRequestedWorkspaceRoot)
      : undefined;
  const parentWorkspaceRoot = normalizeWorkspaceRoot(
    params.parentWorkspaceRoot ??
      (runtimeOwnedPlannerWorkspaceRoot &&
          isConcreteExecutableEnvelopeRoot(runtimeOwnedPlannerWorkspaceRoot)
        ? runtimeOwnedPlannerWorkspaceRoot
        : undefined),
  );
  if (!parentWorkspaceRoot) {
    return buildMissingParentWorkspaceAuthorityFailure(params.source);
  }

  const parentAllowedReadRoots = normalizeParentRoots(
    params.parentAllowedReadRoots,
    parentWorkspaceRoot,
  );
  const parentAllowedWriteRoots = normalizeParentRoots(
    params.parentAllowedWriteRoots,
    parentWorkspaceRoot,
  );

  const requestedContext = params.requestedExecutionContext
    ? canonicalizeDelegationExecutionContext(params.requestedExecutionContext, {
        inheritedWorkspaceRoot: parentWorkspaceRoot,
        hostWorkspaceRoot: parentWorkspaceRoot,
      })
    : undefined;

  const requestedWorkspaceRoot = normalizeWorkspaceRoot(
    requestedContext?.workspaceRoot,
  );
  // When the planner emits a workspace root outside the parent's authority,
  // correct it to the parent workspace root instead of hard-failing.
  // The model's intent is to work in the session workspace; it sometimes
  // hallucinates a different path from its context window.
  const workspaceRootCorrected = Boolean(
    requestedWorkspaceRoot &&
    !isPathWithinRoot(requestedWorkspaceRoot, parentWorkspaceRoot),
  );
  const childWorkspaceRoot =
    requestedWorkspaceRoot && !workspaceRootCorrected
      ? requestedWorkspaceRoot
      : parentWorkspaceRoot;

  // When the workspace root was corrected, the requested read/write roots and
  // artifacts were specified against the hallucinated workspace path.  They are
  // no longer meaningful relative to the corrected workspace, so we discard
  // them and let the derivation fall through to parent defaults.
  const requestedReadRoots = workspaceRootCorrected
    ? undefined
    : normalizeRequestedRoots(
        requestedContext?.allowedReadRoots,
        childWorkspaceRoot,
      );
  if (
    requestedReadRoots?.some(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    )
  ) {
    const offendingPath = requestedReadRoots.find(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    );
    return buildDerivationFailure({
      code: "read_root_outside_parent_workspace",
      message:
        `Requested delegated read root "${offendingPath}" is outside the trusted parent workspace authority.`,
      path: offendingPath,
    });
  }

  const requestedWriteRoots = workspaceRootCorrected
    ? undefined
    : normalizeRequestedRoots(
        requestedContext?.allowedWriteRoots,
        childWorkspaceRoot,
      );
  if (
    requestedWriteRoots?.some(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedWriteRoots),
    )
  ) {
    const offendingPath = requestedWriteRoots.find(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedWriteRoots),
    );
    return buildDerivationFailure({
      code: "write_root_outside_parent_workspace",
      message:
        `Requested delegated write root "${offendingPath}" is outside the trusted parent workspace authority.`,
      path: offendingPath,
    });
  }

  const inputArtifacts = workspaceRootCorrected
    ? undefined
    : normalizeRequestedArtifacts(
        requestedContext?.inputArtifacts,
        childWorkspaceRoot,
      );
  if (
    inputArtifacts?.some(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    )
  ) {
    const offendingPath = inputArtifacts.find(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    );
    return buildDerivationFailure({
      code: "input_artifact_outside_parent_workspace",
      message:
        `Requested delegated input artifact "${offendingPath}" is outside the trusted parent workspace authority.`,
      path: offendingPath,
    });
  }

  const requiredSourceArtifacts = workspaceRootCorrected
    ? undefined
    : normalizeRequestedArtifacts(
        requestedContext?.requiredSourceArtifacts ?? requestedContext?.inputArtifacts,
        childWorkspaceRoot,
      );
  if (
    requiredSourceArtifacts?.some(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    )
  ) {
    const offendingPath = requiredSourceArtifacts.find(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedReadRoots),
    );
    return buildDerivationFailure({
      code: "required_source_outside_parent_workspace",
      message:
        `Requested delegated required source artifact "${offendingPath}" is outside the trusted parent workspace authority.`,
      path: offendingPath,
    });
  }

  const targetArtifacts = workspaceRootCorrected
    ? undefined
    : normalizeRequestedArtifacts(
        requestedContext?.targetArtifacts,
        childWorkspaceRoot,
      );
  if (
    targetArtifacts?.some(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedWriteRoots),
    )
  ) {
    const offendingPath = targetArtifacts.find(
      (path) =>
        !isPathWithinRoot(path, childWorkspaceRoot) ||
        !isPathWithinAnyRoot(path, parentAllowedWriteRoots),
    );
    return buildDerivationFailure({
      code: "target_outside_parent_workspace",
      message:
        `Requested delegated target artifact "${offendingPath}" is outside the trusted parent workspace authority.`,
      path: offendingPath,
    });
  }

  const defaultAllowedReadRoots = parentAllowedReadRoots.filter((path) =>
    isPathWithinRoot(path, childWorkspaceRoot)
  );
  const defaultAllowedWriteRoots = parentAllowedWriteRoots.filter((path) =>
    isPathWithinRoot(path, childWorkspaceRoot)
  );

  const executionContext = buildDelegationExecutionContext({
    workspaceRoot: childWorkspaceRoot,
    allowedReadRoots:
      requestedReadRoots ??
      (defaultAllowedReadRoots.length > 0
        ? defaultAllowedReadRoots
        : [childWorkspaceRoot]),
    allowedWriteRoots:
      requestedWriteRoots ??
      (defaultAllowedWriteRoots.length > 0
        ? defaultAllowedWriteRoots
        : [childWorkspaceRoot]),
    allowedTools: requestedContext?.allowedTools,
    inputArtifacts,
    requiredSourceArtifacts,
    targetArtifacts,
    effectClass: requestedContext?.effectClass,
    verificationMode: requestedContext?.verificationMode,
    stepKind: requestedContext?.stepKind,
    completionContract: requestedContext?.completionContract,
    fallbackPolicy: requestedContext?.fallbackPolicy,
    resumePolicy: requestedContext?.resumePolicy,
    approvalProfile: requestedContext?.approvalProfile,
  });

  return {
    ok: true,
    executionContext,
    // Audit S1.6: normalize so the working directory passed to spawned
    // child processes uses path.resolve + ~ expansion, matching the
    // upstream parent workspace root used elsewhere in this file.
    workingDirectory: normalizeWorkspaceRoot(executionContext?.workspaceRoot),
  };
}
