import path from "node:path";
import { computeDocumentDigest, type Sha256Digest } from "../eval-contract/index.js";
import {
  decodeStrictJson,
  loadArtifact,
  openStableDirectory,
  readBoundedRegularFile,
} from "../eval-pilot/safe-io.js";
import {
  EVAL_EXECUTOR_MAXIMUM_LOCK_BYTES,
  PILOT_SOURCE_LOCK_KIND,
  PILOT_SOURCE_LOCK_VERSION,
  type CasArtifactReference,
  type LoadedPilotSourceLock,
  type PilotSourceLock,
  type PilotSourceLockTask,
} from "./types.js";

export class EvalExecutorError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "EvalExecutorError";
    this.issues = issues;
  }
}

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const IMAGE_WITH_DIGEST_PATTERN = /^[^@\s]+@sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvalExecutorError([`${label} must be a non-empty string`]);
  }
  return value;
}

function assertStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new EvalExecutorError([`${label} must be an array of strings`]);
  }
  return value as readonly string[];
}

function assertArtifactReference(value: unknown, label: string): CasArtifactReference {
  if (!isRecord(value)) {
    throw new EvalExecutorError([`${label} must be an object`]);
  }
  const digest = assertString(value.digest, `${label}.digest`);
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new EvalExecutorError([`${label}.digest must be a sha256 digest`]);
  }
  const sizeBytes = value.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new EvalExecutorError([`${label}.sizeBytes must be a non-negative safe integer`]);
  }
  const uri = assertString(value.uri, `${label}.uri`);
  const expectedUri = `cas://sha256/${digest.slice("sha256:".length)}`;
  if (uri !== expectedUri) {
    throw new EvalExecutorError([`${label}.uri must be ${expectedUri}`]);
  }
  return {
    digest: digest as Sha256Digest,
    sizeBytes,
    mediaType: assertString(value.mediaType, `${label}.mediaType`),
    uri,
  };
}

function assertTask(value: unknown, index: number): PilotSourceLockTask {
  const label = `tasks[${index}]`;
  if (!isRecord(value)) {
    throw new EvalExecutorError([`${label} must be an object`]);
  }
  const ordinal = value.ordinal;
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new EvalExecutorError([`${label}.ordinal must be a positive integer`]);
  }
  const baseCommit = assertString(value.baseCommit, `${label}.baseCommit`);
  if (!GIT_COMMIT_PATTERN.test(baseCommit)) {
    throw new EvalExecutorError([`${label}.baseCommit must be a 40-hex git commit`]);
  }
  const sourceRowDigest = assertString(value.sourceRowDigest, `${label}.sourceRowDigest`);
  if (!SHA256_DIGEST_PATTERN.test(sourceRowDigest)) {
    throw new EvalExecutorError([`${label}.sourceRowDigest must be a sha256 digest`]);
  }
  const image = assertString(value.image, `${label}.image`);
  if (!IMAGE_WITH_DIGEST_PATTERN.test(image)) {
    throw new EvalExecutorError([
      `${label}.image must carry an immutable @sha256 manifest digest`,
    ]);
  }
  if (!isRecord(value.artifacts)) {
    throw new EvalExecutorError([`${label}.artifacts must be an object`]);
  }
  return {
    ordinal,
    language: assertString(value.language, `${label}.language`),
    instanceId: assertString(value.instanceId, `${label}.instanceId`),
    categories: assertStringArray(value.categories, `${label}.categories`),
    stressors: assertStringArray(value.stressors, `${label}.stressors`),
    sourceRowDigest: sourceRowDigest as Sha256Digest,
    repository: assertString(value.repository, `${label}.repository`),
    pullNumber: assertString(value.pullNumber, `${label}.pullNumber`),
    issueNumbers: assertStringArray(value.issueNumbers, `${label}.issueNumbers`),
    baseCommit,
    createdAt: assertString(value.createdAt, `${label}.createdAt`),
    commitUrl: assertString(value.commitUrl, `${label}.commitUrl`),
    issueText: assertString(value.issueText, `${label}.issueText`),
    image,
    artifacts: {
      setupPatch: assertArtifactReference(value.artifacts.setupPatch, `${label}.artifacts.setupPatch`),
      referencePatch: assertArtifactReference(
        value.artifacts.referencePatch,
        `${label}.artifacts.referencePatch`,
      ),
      verifierBundle: assertArtifactReference(
        value.artifacts.verifierBundle,
        `${label}.artifacts.verifierBundle`,
      ),
      sourceEvidence: assertArtifactReference(
        value.artifacts.sourceEvidence,
        `${label}.artifacts.sourceEvidence`,
      ),
    },
  };
}

function assertPilotSourceLock(value: unknown, file: string): PilotSourceLock {
  if (!isRecord(value)) {
    throw new EvalExecutorError([`${file} must contain a JSON object`]);
  }
  if (value.kind !== PILOT_SOURCE_LOCK_KIND) {
    throw new EvalExecutorError([`${file} kind must be ${PILOT_SOURCE_LOCK_KIND}`]);
  }
  if (value.version !== PILOT_SOURCE_LOCK_VERSION) {
    throw new EvalExecutorError([`${file} version must be ${PILOT_SOURCE_LOCK_VERSION}`]);
  }
  const documentDigest = assertString(value.documentDigest, `${file} documentDigest`);
  if (!SHA256_DIGEST_PATTERN.test(documentDigest)) {
    throw new EvalExecutorError([`${file} documentDigest must be a sha256 digest`]);
  }
  if (!isRecord(value.source)) {
    throw new EvalExecutorError([`${file} source must be an object`]);
  }
  if (value.source.selectionBeforeAgentOutcomes !== true) {
    throw new EvalExecutorError([
      `${file} source.selectionBeforeAgentOutcomes must be true; outcome-aware selection is not a pilot`,
    ]);
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new EvalExecutorError([`${file} tasks must be a non-empty array`]);
  }
  const tasks = value.tasks.map((task, index) => assertTask(task, index));
  const instanceIds = new Set(tasks.map((task) => task.instanceId));
  if (instanceIds.size !== tasks.length) {
    throw new EvalExecutorError([`${file} tasks must have unique instanceIds`]);
  }
  const lock: PilotSourceLock = {
    kind: PILOT_SOURCE_LOCK_KIND,
    version: PILOT_SOURCE_LOCK_VERSION,
    documentDigest: documentDigest as Sha256Digest,
    createdAt: assertString(value.createdAt, `${file} createdAt`),
    source: {
      datasetId: assertString(value.source.datasetId, `${file} source.datasetId`),
      datasetRevision: assertString(value.source.datasetRevision, `${file} source.datasetRevision`),
      repositoryUri: assertString(value.source.repositoryUri, `${file} source.repositoryUri`),
      repositoryCommit: assertString(
        value.source.repositoryCommit,
        `${file} source.repositoryCommit`,
      ),
      license: assertString(value.source.license, `${file} source.license`),
      selectionAlgorithm: assertString(
        value.source.selectionAlgorithm,
        `${file} source.selectionAlgorithm`,
      ),
      selectionBeforeAgentOutcomes: true,
    },
    tasks,
  };
  const recomputed = computeDocumentDigest(value as Parameters<typeof computeDocumentDigest>[0]);
  if (recomputed !== lock.documentDigest) {
    throw new EvalExecutorError([
      `${file} documentDigest mismatch: recorded ${lock.documentDigest}, recomputed ${recomputed}`,
    ]);
  }
  return lock;
}

/**
 * Load and validate a frozen pilot source lock plus its sibling CAS layout.
 * The document digest is recomputed; any drift from the committed bytes is a
 * hard failure, never a warning.
 */
export async function loadPilotSourceLock(lockFile: string): Promise<LoadedPilotSourceLock> {
  const resolved = path.resolve(lockFile);
  const bytes = await readBoundedRegularFile(resolved, EVAL_EXECUTOR_MAXIMUM_LOCK_BYTES);
  const value = decodeStrictJson(bytes, resolved);
  const lock = assertPilotSourceLock(value, resolved);
  const casSha = await openStableDirectory(
    path.join(path.dirname(resolved), "cas", "sha256"),
    "pilot CAS SHA-256 directory",
  );
  return { lock, casShaRoot: casSha.canonicalPath };
}

export function findPilotTask(lock: PilotSourceLock, instanceId: string): PilotSourceLockTask {
  const task = lock.tasks.find((candidate) => candidate.instanceId === instanceId);
  if (!task) {
    throw new EvalExecutorError([
      `task ${instanceId} is not in the source lock; known tasks: ${
        lock.tasks.map((candidate) => candidate.instanceId).join(", ")
      }`,
    ]);
  }
  return task;
}

/** Read one pinned CAS artifact with digest, size, and containment checks. */
export async function readPilotArtifact(
  loaded: LoadedPilotSourceLock,
  artifact: CasArtifactReference,
): Promise<Uint8Array> {
  return loadArtifact(loaded.casShaRoot, artifact);
}
