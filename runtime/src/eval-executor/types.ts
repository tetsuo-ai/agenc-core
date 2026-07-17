import type { Sha256Digest } from "../eval-contract/index.js";

/** Media types pinned by the frozen pilot source lock. */
export const PILOT_SOURCE_LOCK_KIND = "agenc.eval.pilot-source-lock";
export const PILOT_SOURCE_LOCK_VERSION = "1.0.0";
export const VERIFIER_BUNDLE_KIND = "agenc.eval.swe-bench-live-verifier-bundle";
export const VERIFIER_BUNDLE_VERSION = "1.0.0";

/** Matches the pilot CAS bound; decompressed verifier bundles share it. */
export const EVAL_EXECUTOR_MAXIMUM_ARTIFACT_BYTES = 16_777_216;
export const EVAL_EXECUTOR_MAXIMUM_LOCK_BYTES = 16_777_216;

/** Host-side cap on captured container command output. */
export const EVAL_EXECUTOR_MAXIMUM_CAPTURED_OUTPUT_BYTES = 1_048_576;

export interface CasArtifactReference {
  readonly digest: Sha256Digest;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly uri: string;
}

export interface PilotSourceLockTask {
  readonly ordinal: number;
  readonly language: string;
  readonly instanceId: string;
  readonly categories: readonly string[];
  readonly stressors: readonly string[];
  readonly sourceRowDigest: Sha256Digest;
  readonly repository: string;
  readonly pullNumber: string;
  readonly issueNumbers: readonly string[];
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly commitUrl: string;
  readonly issueText: string;
  /** OCI reference; execution must use the trailing immutable digest. */
  readonly image: string;
  readonly artifacts: {
    readonly setupPatch: CasArtifactReference;
    readonly referencePatch: CasArtifactReference;
    readonly verifierBundle: CasArtifactReference;
    readonly sourceEvidence: CasArtifactReference;
  };
}

export interface PilotSourceLock {
  readonly kind: typeof PILOT_SOURCE_LOCK_KIND;
  readonly version: typeof PILOT_SOURCE_LOCK_VERSION;
  readonly documentDigest: Sha256Digest;
  readonly createdAt: string;
  readonly source: {
    readonly datasetId: string;
    readonly datasetRevision: string;
    readonly repositoryUri: string;
    readonly repositoryCommit: string;
    readonly license: string;
    readonly selectionAlgorithm: string;
    readonly selectionBeforeAgentOutcomes: boolean;
  };
  readonly tasks: readonly PilotSourceLockTask[];
}

export interface LoadedPilotSourceLock {
  readonly lock: PilotSourceLock;
  /** Canonical `cas/sha256` directory beside the lock file. */
  readonly casShaRoot: string;
}

export interface VerifierBundle {
  readonly kind: typeof VERIFIER_BUNDLE_KIND;
  readonly version: typeof VERIFIER_BUNDLE_VERSION;
  readonly instanceId: string;
  readonly testPatch: string;
  readonly rebuildCommands: readonly string[];
  readonly testCommands: readonly string[];
  readonly printCommands: readonly string[];
  /** Python `parser(log: str) -> dict[str, str]` source, executed in-container. */
  readonly logParser: string;
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
}

export interface ContainerHandle {
  readonly id: string;
  readonly imageDigest: string;
  readonly workdir: string;
}

export interface ContainerExecRequest {
  /** POSIX shell script executed with `bash -c` inside the workdir. */
  readonly script: string;
  readonly timeoutMs: number;
}

export interface ContainerExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/**
 * Minimal container surface the preflight orchestration needs. The docker
 * implementation always creates task containers with `--network none`; fakes
 * exist only for hermetic tests.
 */
export interface ContainerRunner {
  createTaskContainer(imageReference: string): Promise<ContainerHandle>;
  /**
   * Executor-owned tooling container (also `--network none`), e.g. to run
   * the frozen log parser when a task image ships no python3. Never used
   * for task material, so the image is operator configuration and may be a
   * tag instead of a digest pin.
   */
  createAuxiliaryContainer(imageReference: string): Promise<ContainerHandle>;
  exec(handle: ContainerHandle, request: ContainerExecRequest): Promise<ContainerExecResult>;
  writeFile(handle: ContainerHandle, containerPath: string, bytes: Uint8Array): Promise<void>;
  /** Copy one file between containers without staging it on the host. */
  copyFile(
    source: ContainerHandle,
    sourcePath: string,
    target: ContainerHandle,
    targetPath: string,
  ): Promise<void>;
  remove(handle: ContainerHandle): Promise<void>;
  environment(): Promise<ContainerEnvironment>;
}

export interface ContainerEnvironment {
  readonly engine: "docker";
  readonly serverVersion: string;
  readonly platform: string;
  readonly arch: string;
}

export type PreflightFailureReason =
  | "base_unexpectedly_passes"
  | "regression_check_failed"
  | "reference_solution_failed"
  | "patch_apply_failed"
  | "rebuild_failed"
  | "network_required"
  | "test_command_failed"
  | "parser_failed"
  | "timeout"
  | "infrastructure_error";

export interface PreflightCommandRecord {
  readonly label: string;
  readonly script: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly stdoutDigest: Sha256Digest;
  readonly stderrDigest: Sha256Digest;
  /** Bounded human-triage excerpts; digests above cover the captured text. */
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
}

export interface PreflightPhaseTranscript {
  readonly phase: "base" | "reference";
  readonly imageDigest: string;
  readonly appliedPatches: readonly string[];
  readonly commands: readonly PreflightCommandRecord[];
  /** Parsed test name -> upstream status string, when parsing succeeded. */
  readonly testResults: Readonly<Record<string, string>> | null;
}

export interface PreflightRunReport {
  readonly taskId: string;
  readonly runIndex: 1 | 2 | 3;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly phases: readonly PreflightPhaseTranscript[];
  readonly verdicts: {
    readonly coldRebuild: true;
    readonly baseFailsTargetChecks: boolean;
    readonly basePassesRegressionChecks: boolean;
    readonly referencePassesAllChecks: boolean;
  };
  readonly failure: {
    readonly reason: PreflightFailureReason;
    readonly detail: string;
  } | null;
  readonly environmentDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
}

export interface TriplePreflightResult {
  readonly taskId: string;
  readonly qualified: boolean;
  readonly runs: readonly PreflightRunReport[];
}
