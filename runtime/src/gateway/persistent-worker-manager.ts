import type { MemoryBackend } from "../memory/types.js";
import type {
  RuntimeMailboxLayerSnapshot,
  RuntimeMailboxMessage,
  RuntimePermissionRequestMessage,
  RuntimeExecutionLocation,
  RuntimeWorkerHandle,
  RuntimeWorkerLayerSnapshot,
  RuntimeVerifierVerdict,
} from "../runtime-contract/types.js";
import type { Task, TaskStore } from "../tools/system/task-tracker.js";
import type { SystemRemoteSessionManager } from "../tools/system/remote-session.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import type {
  ApprovalDisposition,
  ApprovalEngine,
  ApprovalRequest,
} from "./approvals.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import {
  resolveDelegatedTerminalOutcome,
} from "./delegated-runtime-result.js";
import type { SubAgentManager } from "./sub-agent.js";
import { PersistentWorkerMailbox } from "./persistent-worker-mailbox.js";
import {
  reportManagedRemoteSession,
  startManagedRemoteSession,
} from "./remote-execution-handles.js";
import type { SessionShellProfile } from "./shell-profile.js";
import { coerceSessionShellProfile } from "./shell-profile.js";
import { buildDelegatedChildPrompt } from "./tool-handler-factory-delegation.js";
import type { VerifierRequirement } from "./verifier-probes.js";
import { specRequiresSuccessfulToolEvidence } from "../utils/delegation-validation.js";
import { WorktreeIsolationManager } from "./worktree-isolation.js";

const PERSISTENT_WORKER_KEY_PREFIX = "persistent-worker:session:";
const PERSISTENT_WORKER_SCHEMA_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 75;

export const WORKER_ASSIGNMENT_METADATA_KEY = "workerAssignment";

export type PersistentWorkerState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_for_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface PreparedPersistentWorkerAssignment {
  readonly request: ExecuteWithAgentInput;
  readonly objective: string;
  readonly admittedInput: ExecuteWithAgentInput;
  readonly shellProfile?: SessionShellProfile;
  readonly allowedTools: readonly string[];
  readonly workingDirectory?: string;
  readonly executionContextFingerprint?: string;
  readonly executionEnvelopeFingerprint: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly ownedArtifacts?: readonly string[];
  readonly unsafeBenchmarkMode?: boolean;
}

export interface WorkerAssignmentMetadata {
  readonly targetWorkerId?: string;
  readonly targetWorkerName?: string;
  readonly assignment: PreparedPersistentWorkerAssignment;
}

interface PersistentWorkerRecord {
  readonly version: number;
  readonly workerId: string;
  readonly workerName: string;
  readonly parentSessionId: string;
  shellProfile?: SessionShellProfile;
  state: PersistentWorkerState;
  stopRequested: boolean;
  currentTaskId?: string;
  lastTaskId?: string;
  continuationSessionId?: string;
  activeSubagentSessionId?: string;
  workingDirectory?: string;
  allowedTools?: readonly string[];
  executionContextFingerprint?: string;
  executionEnvelopeFingerprint?: string;
  verifierRequirement?: VerifierRequirement;
  executionLocation?: RuntimeExecutionLocation;
  remoteSessionHandleId?: string;
  remoteSessionCallbackToken?: string;
  queuedCoordinatorNotes?: readonly string[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

interface PersistentWorkerRegistry {
  readonly version: number;
  readonly parentSessionId: string;
  nextWorkerNumber: number;
  workers: PersistentWorkerRecord[];
}

interface PersistentWorkerManagerOptions {
  readonly memoryBackend: MemoryBackend;
  readonly taskStore: TaskStore;
  readonly subAgentManager: SubAgentManager;
  readonly approvalEngine?: ApprovalEngine | null;
  readonly mailbox?: PersistentWorkerMailbox | null;
  readonly worktreeIsolation?: WorktreeIsolationManager | null;
  readonly worktreeIsolationEnabled?: boolean;
  readonly remoteIsolationEnabled?: boolean;
  readonly remoteSessionManager?: Pick<
    SystemRemoteSessionManager,
    "start" | "handleWebhook"
  > | null;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly onTraceEvent?: (
    event: PersistentWorkerTraceEvent,
  ) => void | Promise<void>;
}

export interface PersistentWorkerTraceEvent {
  readonly type:
    | "spawned"
    | "reuse_selected"
    | "assignment_queued"
    | "assignment_claimed"
    | "verifier_started"
    | "verifier_result"
    | "idle"
    | "permission_blocked"
    | "permission_resolved"
    | "stop_requested"
    | "stopped"
    | "failed"
    | "recovered_requeue"
    | "execution_location_selected"
    | "execution_location_fallback";
  readonly parentSessionId: string;
  readonly workerId: string;
  readonly timestamp: number;
  readonly taskId?: string;
  readonly workerState?: PersistentWorkerState;
  readonly summary?: string;
  readonly verifierVerdict?: RuntimeVerifierVerdict["overall"];
  readonly executionLocation?: RuntimeExecutionLocation;
  readonly reason?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function asPlainObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneExecutionLocation(
  location: RuntimeExecutionLocation | undefined,
): RuntimeExecutionLocation | undefined {
  return location ? cloneJson(location) : undefined;
}

function isMutationLikeAssignment(
  assignment: PreparedPersistentWorkerAssignment,
): boolean {
  if ((assignment.ownedArtifacts?.length ?? 0) > 0) {
    return true;
  }
  const effectClass = assignment.admittedInput.executionContext?.effectClass;
  return effectClass !== undefined && effectClass !== "read_only";
}

function cloneVerifierRequirement(
  requirement: VerifierRequirement | undefined,
): VerifierRequirement | undefined {
  if (!requirement) return undefined;
  return {
    required: requirement.required,
    profiles: [...requirement.profiles],
    probeCategories: [...requirement.probeCategories],
    mutationPolicy: requirement.mutationPolicy,
    allowTempArtifacts: requirement.allowTempArtifacts,
    bootstrapSource: requirement.bootstrapSource,
    rationale: [...requirement.rationale],
  };
}

function clonePreparedAssignment(
  assignment: PreparedPersistentWorkerAssignment,
): PreparedPersistentWorkerAssignment {
  return {
    request: cloneJson(assignment.request),
    objective: assignment.objective,
    admittedInput: cloneJson(assignment.admittedInput),
    ...(assignment.shellProfile
      ? { shellProfile: assignment.shellProfile }
      : {}),
    allowedTools: [...assignment.allowedTools],
    ...(assignment.workingDirectory
      ? { workingDirectory: assignment.workingDirectory }
      : {}),
    ...(assignment.executionContextFingerprint
      ? { executionContextFingerprint: assignment.executionContextFingerprint }
      : {}),
    executionEnvelopeFingerprint: assignment.executionEnvelopeFingerprint,
    ...(assignment.verifierRequirement
      ? { verifierRequirement: cloneVerifierRequirement(assignment.verifierRequirement) }
      : {}),
    ...(assignment.ownedArtifacts
      ? { ownedArtifacts: [...assignment.ownedArtifacts] }
      : {}),
    ...(assignment.unsafeBenchmarkMode === true
      ? { unsafeBenchmarkMode: true }
      : {}),
  };
}

function cloneWorkerRecord(record: PersistentWorkerRecord): PersistentWorkerRecord {
  return {
    version: record.version,
    workerId: record.workerId,
    workerName: record.workerName,
    parentSessionId: record.parentSessionId,
    ...(record.shellProfile ? { shellProfile: record.shellProfile } : {}),
    state: record.state,
    stopRequested: record.stopRequested,
    ...(record.currentTaskId ? { currentTaskId: record.currentTaskId } : {}),
    ...(record.lastTaskId ? { lastTaskId: record.lastTaskId } : {}),
    ...(record.continuationSessionId
      ? { continuationSessionId: record.continuationSessionId }
      : {}),
    ...(record.activeSubagentSessionId
      ? { activeSubagentSessionId: record.activeSubagentSessionId }
      : {}),
    ...(record.workingDirectory ? { workingDirectory: record.workingDirectory } : {}),
    ...(record.allowedTools ? { allowedTools: [...record.allowedTools] } : {}),
    ...(record.executionContextFingerprint
      ? { executionContextFingerprint: record.executionContextFingerprint }
      : {}),
    ...(record.executionEnvelopeFingerprint
      ? { executionEnvelopeFingerprint: record.executionEnvelopeFingerprint }
      : {}),
    ...(record.verifierRequirement
      ? { verifierRequirement: cloneVerifierRequirement(record.verifierRequirement) }
      : {}),
    ...(record.executionLocation
      ? { executionLocation: cloneExecutionLocation(record.executionLocation) }
      : {}),
    ...(record.remoteSessionHandleId
      ? { remoteSessionHandleId: record.remoteSessionHandleId }
      : {}),
    ...(record.remoteSessionCallbackToken
      ? { remoteSessionCallbackToken: record.remoteSessionCallbackToken }
      : {}),
    ...(record.queuedCoordinatorNotes
      ? { queuedCoordinatorNotes: [...record.queuedCoordinatorNotes] }
      : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function cloneRegistry(registry: PersistentWorkerRegistry): PersistentWorkerRegistry {
  return {
    version: registry.version,
    parentSessionId: registry.parentSessionId,
    nextWorkerNumber: registry.nextWorkerNumber,
    workers: registry.workers.map(cloneWorkerRecord),
  };
}

function createEmptyRegistry(parentSessionId: string): PersistentWorkerRegistry {
  return {
    version: PERSISTENT_WORKER_SCHEMA_VERSION,
    parentSessionId,
    nextWorkerNumber: 1,
    workers: [],
  };
}

function coerceVerifierRequirement(value: unknown): VerifierRequirement | undefined {
  const raw = asPlainObject(value);
  if (!raw || typeof raw.required !== "boolean") {
    return undefined;
  }
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.filter((entry): entry is string => typeof entry === "string")
    : [];
  const probeCategories = Array.isArray(raw.probeCategories)
    ? raw.probeCategories.filter((entry): entry is string => typeof entry === "string")
    : [];
  const mutationPolicy =
    raw.mutationPolicy === "read_only_workspace"
      ? "read_only_workspace"
      : undefined;
  const bootstrapSource =
    raw.bootstrapSource === "disabled" ||
    raw.bootstrapSource === "derived" ||
    raw.bootstrapSource === "fallback"
      ? raw.bootstrapSource
      : undefined;
  if (!mutationPolicy || !bootstrapSource) {
    return undefined;
  }
  return {
    required: raw.required,
    profiles: profiles as VerifierRequirement["profiles"],
    probeCategories: probeCategories as VerifierRequirement["probeCategories"],
    mutationPolicy,
    allowTempArtifacts: raw.allowTempArtifacts === true,
    bootstrapSource,
    rationale: Array.isArray(raw.rationale)
      ? raw.rationale.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function coercePreparedAssignment(
  value: unknown,
): PreparedPersistentWorkerAssignment | undefined {
  const raw = asPlainObject(value);
  if (!raw) return undefined;
  const request = asPlainObject(raw.request);
  const admittedInput = asPlainObject(raw.admittedInput);
  const objective = asNonEmptyString(raw.objective);
  const executionEnvelopeFingerprint = asNonEmptyString(
    raw.executionEnvelopeFingerprint,
  );
  if (!request || !admittedInput || !objective || !executionEnvelopeFingerprint) {
    return undefined;
  }
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    request: cloneJson(request) as unknown as ExecuteWithAgentInput,
    objective,
    admittedInput: cloneJson(admittedInput) as unknown as ExecuteWithAgentInput,
    ...(coerceSessionShellProfile(raw.shellProfile)
      ? { shellProfile: coerceSessionShellProfile(raw.shellProfile) }
      : {}),
    allowedTools,
    ...(asNonEmptyString(raw.workingDirectory)
      ? { workingDirectory: asNonEmptyString(raw.workingDirectory) }
      : {}),
    ...(asNonEmptyString(raw.executionContextFingerprint)
      ? {
          executionContextFingerprint: asNonEmptyString(
            raw.executionContextFingerprint,
          ),
        }
      : {}),
    executionEnvelopeFingerprint,
    ...(coerceVerifierRequirement(raw.verifierRequirement)
      ? { verifierRequirement: coerceVerifierRequirement(raw.verifierRequirement) }
      : {}),
    ...(Array.isArray(raw.ownedArtifacts)
      ? {
          ownedArtifacts: raw.ownedArtifacts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(raw.unsafeBenchmarkMode === true ? { unsafeBenchmarkMode: true } : {}),
  };
}

function coerceAssignmentMetadata(value: unknown): WorkerAssignmentMetadata | undefined {
  const raw = asPlainObject(value);
  const assignment = coercePreparedAssignment(raw?.assignment);
  if (!raw || !assignment) return undefined;
  return {
    ...(asNonEmptyString(raw.targetWorkerId)
      ? { targetWorkerId: asNonEmptyString(raw.targetWorkerId) }
      : {}),
    ...(asNonEmptyString(raw.targetWorkerName)
      ? { targetWorkerName: asNonEmptyString(raw.targetWorkerName) }
      : {}),
    assignment,
  };
}

function coerceWorkerRecord(value: unknown, parentSessionId: string): PersistentWorkerRecord | undefined {
  const raw = asPlainObject(value);
  const workerId = asNonEmptyString(raw?.workerId);
  const workerName = asNonEmptyString(raw?.workerName);
  const state = raw?.state;
  if (
    !raw ||
    !workerId ||
    !workerName ||
    (state !== "starting" &&
      state !== "running" &&
      state !== "idle" &&
      state !== "waiting_for_permission" &&
      state !== "verifying" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "cancelled")
  ) {
    return undefined;
  }
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt;
  return {
    version:
      typeof raw.version === "number" && Number.isInteger(raw.version)
        ? raw.version
        : PERSISTENT_WORKER_SCHEMA_VERSION,
    workerId,
    workerName,
    parentSessionId:
      asNonEmptyString(raw.parentSessionId) ?? parentSessionId,
    ...(coerceSessionShellProfile(raw.shellProfile)
      ? { shellProfile: coerceSessionShellProfile(raw.shellProfile) }
      : {}),
    state,
    stopRequested: raw.stopRequested === true,
    ...(asNonEmptyString(raw.currentTaskId)
      ? { currentTaskId: asNonEmptyString(raw.currentTaskId) }
      : {}),
    ...(asNonEmptyString(raw.lastTaskId)
      ? { lastTaskId: asNonEmptyString(raw.lastTaskId) }
      : {}),
    ...(asNonEmptyString(raw.continuationSessionId)
      ? { continuationSessionId: asNonEmptyString(raw.continuationSessionId) }
      : {}),
    ...(asNonEmptyString(raw.activeSubagentSessionId)
      ? { activeSubagentSessionId: asNonEmptyString(raw.activeSubagentSessionId) }
      : {}),
    ...(asNonEmptyString(raw.workingDirectory)
      ? { workingDirectory: asNonEmptyString(raw.workingDirectory) }
      : {}),
    ...(Array.isArray(raw.allowedTools)
      ? {
          allowedTools: raw.allowedTools.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.executionContextFingerprint)
      ? {
          executionContextFingerprint: asNonEmptyString(
            raw.executionContextFingerprint,
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.executionEnvelopeFingerprint)
      ? {
          executionEnvelopeFingerprint: asNonEmptyString(
            raw.executionEnvelopeFingerprint,
          ),
        }
      : {}),
    ...(coerceVerifierRequirement(raw.verifierRequirement)
      ? { verifierRequirement: coerceVerifierRequirement(raw.verifierRequirement) }
      : {}),
    ...(raw.executionLocation &&
      typeof raw.executionLocation === "object" &&
      raw.executionLocation !== null
      ? {
          executionLocation: cloneJson(
            raw.executionLocation as RuntimeExecutionLocation,
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.remoteSessionHandleId)
      ? { remoteSessionHandleId: asNonEmptyString(raw.remoteSessionHandleId) }
      : {}),
    ...(asNonEmptyString(raw.remoteSessionCallbackToken)
      ? {
          remoteSessionCallbackToken: asNonEmptyString(
            raw.remoteSessionCallbackToken,
          ),
        }
      : {}),
    ...(Array.isArray(raw.queuedCoordinatorNotes)
      ? {
          queuedCoordinatorNotes: raw.queuedCoordinatorNotes.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.summary)
      ? { summary: asNonEmptyString(raw.summary) }
      : {}),
    createdAt,
    updatedAt,
  };
}

function coerceRegistry(
  value: unknown,
  parentSessionId: string,
): PersistentWorkerRegistry {
  const raw = asPlainObject(value);
  if (!raw) {
    return createEmptyRegistry(parentSessionId);
  }
  return {
    version: PERSISTENT_WORKER_SCHEMA_VERSION,
    parentSessionId:
      asNonEmptyString(raw.parentSessionId) ?? parentSessionId,
    nextWorkerNumber:
      typeof raw.nextWorkerNumber === "number" &&
        Number.isInteger(raw.nextWorkerNumber) &&
        raw.nextWorkerNumber > 0
        ? raw.nextWorkerNumber
        : 1,
    workers: Array.isArray(raw.workers)
      ? raw.workers
          .map((entry) => coerceWorkerRecord(entry, parentSessionId))
          .filter((entry): entry is PersistentWorkerRecord => entry !== undefined)
      : [],
  };
}

function isTerminalWorkerState(state: PersistentWorkerState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function normalizeVerifierRequirement(
  requirement: VerifierRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  return stableSerialize({
    required: requirement.required,
    profiles: normalizeStringList(requirement.profiles),
    probeCategories: normalizeStringList(requirement.probeCategories),
    mutationPolicy: requirement.mutationPolicy,
    allowTempArtifacts: requirement.allowTempArtifacts,
    bootstrapSource: requirement.bootstrapSource,
  });
}

function buildRuntimeWorkerHandle(params: {
  readonly worker: PersistentWorkerRecord;
  readonly pendingTaskCount: number;
  readonly pendingInboxCount?: number;
  readonly pendingOutboxCount?: number;
  readonly lastMailboxActivityAt?: number;
}): RuntimeWorkerHandle {
  const continuationSessionId =
    params.worker.activeSubagentSessionId ?? params.worker.continuationSessionId;
  return {
    id: params.worker.workerId,
    kind: "persistent_worker",
    status: params.worker.state,
    updatedAt: params.worker.updatedAt,
    workerId: params.worker.workerId,
    workerName: params.worker.workerName,
    ...(params.worker.shellProfile
      ? { shellProfile: params.worker.shellProfile }
      : {}),
    state: params.worker.state,
    ...(params.worker.currentTaskId ? { taskId: params.worker.currentTaskId } : {}),
    ...(params.worker.currentTaskId
      ? { currentTaskId: params.worker.currentTaskId }
      : {}),
    ...(params.worker.lastTaskId ? { lastTaskId: params.worker.lastTaskId } : {}),
    pendingTaskCount: params.pendingTaskCount,
    ...(continuationSessionId ? { continuationSessionId } : {}),
    ...(params.worker.workingDirectory
      ? { workingDirectory: params.worker.workingDirectory }
      : {}),
    ...(params.worker.executionLocation
      ? { executionLocation: params.worker.executionLocation }
      : {}),
    ...(params.worker.verifierRequirement
      ? { verifierRequirement: params.worker.verifierRequirement }
      : {}),
    pendingInboxCount: params.pendingInboxCount ?? 0,
    pendingOutboxCount: params.pendingOutboxCount ?? 0,
    ...(params.lastMailboxActivityAt !== undefined
      ? { lastMailboxActivityAt: params.lastMailboxActivityAt }
      : {}),
    stopRequested: params.worker.stopRequested,
    ...(params.worker.summary ? { summary: params.worker.summary } : {}),
  };
}

function workerSortPriority(state: PersistentWorkerState): number {
  switch (state) {
    case "idle":
      return 0;
    case "running":
      return 1;
    case "waiting_for_permission":
      return 2;
    case "verifying":
      return 3;
    case "starting":
      return 4;
    case "completed":
      return 5;
    case "failed":
      return 6;
    case "cancelled":
      return 7;
  }
}

export function buildWorkerAssignmentMetadata(params: {
  readonly assignment: PreparedPersistentWorkerAssignment;
  readonly targetWorkerId?: string;
  readonly targetWorkerName?: string;
}): WorkerAssignmentMetadata {
  return {
    ...(params.targetWorkerId ? { targetWorkerId: params.targetWorkerId } : {}),
    ...(params.targetWorkerName ? { targetWorkerName: params.targetWorkerName } : {}),
    assignment: clonePreparedAssignment(params.assignment),
  };
}

export function extractWorkerAssignmentMetadata(
  task: Pick<Task, "metadata">,
): WorkerAssignmentMetadata | undefined {
  return coerceAssignmentMetadata(task.metadata?.[WORKER_ASSIGNMENT_METADATA_KEY]);
}

export class PersistentWorkerManager {
  private readonly memoryBackend: MemoryBackend;
  private readonly taskStore: TaskStore;
  private subAgentManager: SubAgentManager;
  private readonly approvalEngine?: ApprovalEngine | null;
  private readonly mailbox?: PersistentWorkerMailbox | null;
  private readonly worktreeIsolation?: WorktreeIsolationManager | null;
  private readonly worktreeIsolationEnabled: boolean;
  private readonly remoteIsolationEnabled: boolean;
  private readonly remoteSessionManager?: Pick<
    SystemRemoteSessionManager,
    "start" | "handleWebhook"
  > | null;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly queue: KeyedAsyncQueue;
  private readonly onTraceEvent?: PersistentWorkerManagerOptions["onTraceEvent"];

  constructor(options: PersistentWorkerManagerOptions) {
    this.memoryBackend = options.memoryBackend;
    this.taskStore = options.taskStore;
    this.subAgentManager = options.subAgentManager;
    this.approvalEngine = options.approvalEngine;
    this.mailbox = options.mailbox;
    this.worktreeIsolation = options.worktreeIsolation;
    this.worktreeIsolationEnabled = options.worktreeIsolationEnabled === true;
    this.remoteIsolationEnabled = options.remoteIsolationEnabled === true;
    this.remoteSessionManager = options.remoteSessionManager;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.onTraceEvent = options.onTraceEvent;
    this.queue = new KeyedAsyncQueue({
      logger: this.logger,
      label: "persistent worker manager",
    });
  }

  private async emitTraceEvent(
    event: Omit<PersistentWorkerTraceEvent, "timestamp">,
  ): Promise<void> {
    try {
      await this.onTraceEvent?.({
        ...event,
        timestamp: this.now(),
      });
    } catch (error) {
      this.logger.debug("Persistent worker trace listener failed", {
        workerId: event.workerId,
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  updateRuntime(params: {
    readonly subAgentManager: SubAgentManager;
  }): void {
    this.subAgentManager = params.subAgentManager;
  }

  private registryKey(parentSessionId: string): string {
    return `${PERSISTENT_WORKER_KEY_PREFIX}${parentSessionId}`;
  }

  private async loadRegistry(parentSessionId: string): Promise<PersistentWorkerRegistry> {
    return coerceRegistry(
      await this.memoryBackend.get(this.registryKey(parentSessionId)),
      parentSessionId,
    );
  }

  private async saveRegistry(registry: PersistentWorkerRegistry): Promise<void> {
    await this.memoryBackend.set(
      this.registryKey(registry.parentSessionId),
      cloneRegistry(registry),
    );
  }

  private async mutateRegistry<T>(
    parentSessionId: string,
    mutate: (registry: PersistentWorkerRegistry) => Promise<T> | T,
  ): Promise<T> {
    return this.queue.run(this.registryKey(parentSessionId), async () => {
      const registry = await this.loadRegistry(parentSessionId);
      const result = await mutate(registry);
      await this.saveRegistry(registry);
      return result;
    });
  }

  private workerLoopKey(parentSessionId: string, workerId: string): string {
    return `${parentSessionId}:${workerId}`;
  }

  private async getWorkerRecord(
    parentSessionId: string,
    workerId: string,
  ): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(parentSessionId);
    return registry.workers.find((entry) => entry.workerId === workerId);
  }

  private async countPendingAssignments(
    parentSessionId: string,
    workerId: string,
  ): Promise<number> {
    const tasks = await this.taskStore.listTasks(parentSessionId, { status: "pending" });
    return tasks.filter((task) => {
      if (task.kind !== "worker_assignment") return false;
      const metadata = extractWorkerAssignmentMetadata(task);
      return metadata?.targetWorkerId === workerId;
    }).length;
  }

  private async listWorkerRecords(
    parentSessionId: string,
  ): Promise<readonly PersistentWorkerRecord[]> {
    const registry = await this.loadRegistry(parentSessionId);
    return registry.workers.map(cloneWorkerRecord);
  }

  async listWorkers(
    parentSessionId: string,
  ): Promise<readonly RuntimeWorkerHandle[]> {
    const workers = await this.listWorkerRecords(parentSessionId);
    const mailboxCounts: Array<{
      readonly pendingInboxCount: number;
      readonly pendingOutboxCount: number;
      readonly lastMailboxActivityAt?: number;
    }> = await Promise.all(
      workers.map((worker) =>
        this.mailbox?.getWorkerMailboxCounts({
          parentSessionId,
          workerId: worker.workerId,
        }) ?? Promise.resolve({
          pendingInboxCount: 0,
          pendingOutboxCount: 0,
        }),
      ),
    );
    const pendingCounts = await Promise.all(
      workers.map((worker) =>
        this.countPendingAssignments(parentSessionId, worker.workerId),
      ),
    );
    return workers
      .map((worker, index) =>
        buildRuntimeWorkerHandle({
          worker,
          pendingTaskCount: pendingCounts[index] ?? 0,
          pendingInboxCount: mailboxCounts[index]?.pendingInboxCount ?? 0,
          pendingOutboxCount: mailboxCounts[index]?.pendingOutboxCount ?? 0,
          lastMailboxActivityAt: mailboxCounts[index]?.lastMailboxActivityAt,
        }))
      .sort((left, right) => {
        const statePriority =
          workerSortPriority(left.state) - workerSortPriority(right.state);
        if (statePriority !== 0) return statePriority;
        return left.workerName.localeCompare(right.workerName);
      });
  }

  private isWorkerCompatible(
    worker: PersistentWorkerRecord,
    assignment: PreparedPersistentWorkerAssignment,
  ): boolean {
    if (worker.stopRequested || isTerminalWorkerState(worker.state)) {
      return false;
    }
    if ((worker.workingDirectory ?? undefined) !== assignment.workingDirectory) {
      return false;
    }
    if ((worker.shellProfile ?? undefined) !== assignment.shellProfile) {
      return false;
    }
    if (
      (worker.executionContextFingerprint ?? undefined) !==
      assignment.executionContextFingerprint
    ) {
      return false;
    }
    const workerVerifier = normalizeVerifierRequirement(worker.verifierRequirement);
    const assignmentVerifier = normalizeVerifierRequirement(
      assignment.verifierRequirement,
    );
    if (workerVerifier !== assignmentVerifier) {
      return false;
    }
    if (
      worker.allowedTools &&
      assignment.allowedTools.some((toolName) => !worker.allowedTools?.includes(toolName))
    ) {
      return false;
    }
    const desiredMode =
      this.worktreeIsolationEnabled && isMutationLikeAssignment(assignment)
        ? "worktree"
        : this.remoteIsolationEnabled
          ? "remote_session"
          : "local";
    const currentMode = worker.executionLocation?.mode ?? "local";
    if (currentMode !== desiredMode) {
      if (
        desiredMode === "worktree" &&
        currentMode === "local" &&
        worker.executionLocation?.fallbackReason === "workspace_not_git_backed"
      ) {
        return true;
      }
      return false;
    }
    return true;
  }

  private buildLocalExecutionLocation(params: {
    readonly workspaceRoot?: string;
    readonly workingDirectory?: string;
    readonly fallbackReason?: string;
  }): RuntimeExecutionLocation {
    return {
      mode: "local",
      ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
      ...(params.workingDirectory
        ? { workingDirectory: params.workingDirectory }
        : {}),
      ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
    };
  }

  private async selectInitialExecutionLocation(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
  }): Promise<{
    readonly executionLocation: RuntimeExecutionLocation;
    readonly remoteSessionHandleId?: string;
    readonly remoteSessionCallbackToken?: string;
  }> {
    const workspaceRoot =
      params.assignment.admittedInput.executionContext?.workspaceRoot ??
      params.assignment.workingDirectory;
    const workingDirectory = params.assignment.workingDirectory;
    if (this.worktreeIsolationEnabled && isMutationLikeAssignment(params.assignment)) {
      if (!this.worktreeIsolation) {
        throw new Error("Worktree isolation is enabled but unavailable");
      }
      const executionLocation = await this.worktreeIsolation.prepareWorktree({
        workerId: params.workerId,
        workspaceRoot,
        workingDirectory,
      });
      return { executionLocation };
    }
    if (this.remoteIsolationEnabled) {
      if (!this.remoteSessionManager) {
        throw new Error("Remote session isolation is enabled but unavailable");
      }
      const remoteHandle = await startManagedRemoteSession({
        manager: this.remoteSessionManager,
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        shellProfile: params.assignment.shellProfile,
        workspaceRoot,
        workingDirectory,
      });
      return {
        executionLocation: remoteHandle.executionLocation,
        remoteSessionHandleId: remoteHandle.handleId,
        remoteSessionCallbackToken: remoteHandle.callbackToken,
      };
    }
    return {
      executionLocation: this.buildLocalExecutionLocation({
        workspaceRoot,
        workingDirectory,
      }),
    };
  }

  private translateAssignmentForExecution(
    assignment: PreparedPersistentWorkerAssignment,
    executionLocation: RuntimeExecutionLocation | undefined,
  ): PreparedPersistentWorkerAssignment {
    if (
      !executionLocation ||
      executionLocation.mode !== "worktree" ||
      !this.worktreeIsolation
    ) {
      return assignment;
    }
    const translatedExecutionContext = this.worktreeIsolation.translateExecutionContext(
      assignment.admittedInput.executionContext,
      executionLocation,
    );
    const translatedWorkingDirectory =
      this.worktreeIsolation.translatePath(
        assignment.workingDirectory,
        executionLocation,
      ) ?? executionLocation.workingDirectory;
    return {
      ...clonePreparedAssignment(assignment),
      ...(translatedWorkingDirectory
        ? { workingDirectory: translatedWorkingDirectory }
        : {}),
      admittedInput: {
        ...cloneJson(assignment.admittedInput),
        ...(translatedExecutionContext
          ? { executionContext: translatedExecutionContext }
          : {}),
      },
    };
  }

  private async reportRemoteSessionProgress(params: {
    readonly worker: PersistentWorkerRecord | undefined;
    readonly state: "running" | "completed" | "failed" | "cancelled";
    readonly summary: string;
    readonly artifacts?: readonly string[];
  }): Promise<void> {
    if (
      !params.worker ||
      params.worker.executionLocation?.mode !== "remote_session" ||
      !this.remoteSessionManager ||
      !params.worker.remoteSessionHandleId ||
      !params.worker.remoteSessionCallbackToken
    ) {
      return;
    }
    await reportManagedRemoteSession({
      manager: this.remoteSessionManager,
      handleId: params.worker.remoteSessionHandleId,
      callbackToken: params.worker.remoteSessionCallbackToken,
      state: params.state,
      summary: params.summary,
      artifacts: params.artifacts,
      events: [{ summary: params.summary }],
    });
  }

  private async finalizeWorkerExecutionLocation(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
  }): Promise<PersistentWorkerRecord | undefined> {
    const currentWorker = await this.getWorkerRecord(
      params.parentSessionId,
      params.workerId,
    );
    if (!currentWorker || !isTerminalWorkerState(currentWorker.state)) {
      return currentWorker;
    }
    const nextLocation =
      currentWorker.executionLocation?.mode === "worktree" && this.worktreeIsolation
        ? await this.worktreeIsolation.cleanupLocation(currentWorker.executionLocation)
        : currentWorker.executionLocation;
    if (currentWorker.executionLocation?.mode === "remote_session") {
      await this.reportRemoteSessionProgress({
        worker: currentWorker,
        state:
          currentWorker.state === "failed"
            ? "failed"
            : currentWorker.state === "cancelled"
              ? "cancelled"
              : "completed",
        summary: currentWorker.summary ?? "Worker stopped.",
      });
    }
    return this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
      worker.executionLocation = cloneExecutionLocation(nextLocation);
    });
  }

  private findReusableWorker(
    workers: readonly PersistentWorkerRecord[],
    assignment?: PreparedPersistentWorkerAssignment,
  ): PersistentWorkerRecord | undefined {
    return [...workers]
      .filter((worker) =>
        assignment ? this.isWorkerCompatible(worker, assignment) : !isTerminalWorkerState(worker.state) &&
          !worker.stopRequested
      )
      .sort((left, right) => {
        const statePriority =
          workerSortPriority(left.state) - workerSortPriority(right.state);
        if (statePriority !== 0) return statePriority;
        return right.updatedAt - left.updatedAt;
      })[0];
  }

  async getLatestReusableWorkerId(
    parentSessionId: string,
    assignment?: PreparedPersistentWorkerAssignment,
  ): Promise<string | undefined> {
    const registry = await this.loadRegistry(parentSessionId);
    return this.findReusableWorker(registry.workers, assignment)?.workerId;
  }

  async resolveWorkerByAlias(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId: string;
  }): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(params.parentSessionId);
    return registry.workers.find((worker) =>
      worker.workerId === params.workerIdOrSessionId ||
      worker.continuationSessionId === params.workerIdOrSessionId ||
      worker.activeSubagentSessionId === params.workerIdOrSessionId
    );
  }

  async createWorker(params: {
    readonly parentSessionId: string;
    readonly workerName?: string;
  }): Promise<RuntimeWorkerHandle> {
    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const workerNumber = registry.nextWorkerNumber++;
        const workerId = `worker-${workerNumber}`;
        const workerName = asNonEmptyString(params.workerName) ?? workerId;
        if (registry.workers.some((entry) => entry.workerName === workerName)) {
          throw new Error(`Worker name "${workerName}" is already in use`);
        }
        const now = this.now();
        const record: PersistentWorkerRecord = {
          version: PERSISTENT_WORKER_SCHEMA_VERSION,
          workerId,
          workerName,
          parentSessionId: params.parentSessionId,
          state: "idle",
          stopRequested: false,
          createdAt: now,
          updatedAt: now,
          summary: "Worker ready for assignments.",
        };
        registry.workers.push(record);
        return cloneWorkerRecord(record);
      },
    );
    await this.emitTraceEvent({
      type: "spawned",
      parentSessionId: params.parentSessionId,
      workerId: worker.workerId,
      workerState: worker.state,
      summary: worker.summary,
    });
    return buildRuntimeWorkerHandle({
      worker,
      pendingTaskCount: 0,
      pendingInboxCount: 0,
      pendingOutboxCount: 0,
    });
  }

  async assignToWorker(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
  }): Promise<{ readonly worker: RuntimeWorkerHandle; readonly task: Task }> {
    let selectedExecutionLocation: RuntimeExecutionLocation | undefined;
    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const record = registry.workers.find((entry) => entry.workerId === params.workerId);
        if (!record) {
          throw new Error(`Worker "${params.workerId}" was not found`);
        }
        if (record.stopRequested || isTerminalWorkerState(record.state)) {
          throw new Error(`Worker "${params.workerId}" is not available`);
        }
        if (record.workingDirectory === undefined) {
          const initialExecution = await this.selectInitialExecutionLocation({
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            assignment: params.assignment,
          });
          record.shellProfile = params.assignment.shellProfile;
          record.workingDirectory = params.assignment.workingDirectory;
          record.allowedTools = [...params.assignment.allowedTools];
          record.executionContextFingerprint =
            params.assignment.executionContextFingerprint;
          record.executionEnvelopeFingerprint =
            params.assignment.executionEnvelopeFingerprint;
          record.verifierRequirement = cloneVerifierRequirement(
            params.assignment.verifierRequirement,
          );
          record.executionLocation = cloneExecutionLocation(
            initialExecution.executionLocation,
          );
          selectedExecutionLocation = cloneExecutionLocation(
            initialExecution.executionLocation,
          );
          if (initialExecution.remoteSessionHandleId) {
            record.remoteSessionHandleId = initialExecution.remoteSessionHandleId;
          }
          if (initialExecution.remoteSessionCallbackToken) {
            record.remoteSessionCallbackToken =
              initialExecution.remoteSessionCallbackToken;
          }
        } else if (!this.isWorkerCompatible(record, params.assignment)) {
          throw new Error(
            `Worker "${params.workerId}" cannot widen its delegated scope or verifier contract`,
          );
        }
        record.updatedAt = this.now();
        return cloneWorkerRecord(record);
      },
    );
    if (selectedExecutionLocation) {
      await this.emitTraceEvent({
        type: selectedExecutionLocation.fallbackReason
          ? "execution_location_fallback"
          : "execution_location_selected",
        parentSessionId: params.parentSessionId,
        workerId: worker.workerId,
        workerState: worker.state,
        executionLocation: selectedExecutionLocation,
        ...(selectedExecutionLocation.fallbackReason
          ? { reason: selectedExecutionLocation.fallbackReason }
          : {}),
      });
    }

    const task = await this.taskStore.createRuntimeTask({
      listId: params.parentSessionId,
      kind: "worker_assignment",
      subject: params.assignment.objective,
      description:
        params.assignment.request.objective &&
          params.assignment.request.objective !== params.assignment.request.task
          ? params.assignment.request.task
          : params.assignment.objective,
      activeForm: "Running worker assignment",
      status: "pending",
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment: params.assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
        ...(params.assignment.verifierRequirement
          ? {
              _runtime: {
                verification: params.assignment.verifierRequirement.required,
                verifierProfiles: params.assignment.verifierRequirement.profiles,
                verifierProbeCategories:
                  params.assignment.verifierRequirement.probeCategories,
              },
            }
          : {}),
      },
      summary: `Queued for ${worker.workerName}.`,
      ownedArtifacts: params.assignment.ownedArtifacts,
      workingDirectory: params.assignment.workingDirectory,
      isolation:
        params.assignment.admittedInput.delegationAdmission?.isolationReason,
      executionLocation: worker.executionLocation,
    });

    if (this.mailbox) {
      await this.mailbox.sendToWorker({
        type: "task_assignment",
        parentSessionId: params.parentSessionId,
        workerId: worker.workerId,
        taskId: task.id,
        objective: params.assignment.objective,
        summary: `Queued for ${worker.workerName}.`,
      });
    }
    await this.emitTraceEvent({
      type: "assignment_queued",
      parentSessionId: params.parentSessionId,
      workerId: worker.workerId,
      taskId: task.id,
      workerState: worker.state,
      summary: `Queued for ${worker.workerName}.`,
      executionLocation: worker.executionLocation,
    });

    void this.scheduleWorker(params.parentSessionId, worker.workerId);

    return {
      worker: buildRuntimeWorkerHandle({
        worker,
        pendingTaskCount: await this.countPendingAssignments(
          params.parentSessionId,
          worker.workerId,
        ) + 1,
        pendingInboxCount: this.mailbox ? 1 : 0,
      }),
      task,
    };
  }

  async pickWorkerForAssignment(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId?: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
  }): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(params.parentSessionId);
    const worker = params.workerIdOrSessionId
      ? registry.workers.find((worker) =>
        (worker.workerId === params.workerIdOrSessionId ||
          worker.continuationSessionId === params.workerIdOrSessionId ||
          worker.activeSubagentSessionId === params.workerIdOrSessionId) &&
        this.isWorkerCompatible(worker, params.assignment)
      )
      : this.findReusableWorker(registry.workers, params.assignment);
    if (worker) {
      await this.emitTraceEvent({
        type: "reuse_selected",
        parentSessionId: params.parentSessionId,
        workerId: worker.workerId,
        workerState: worker.state,
        executionLocation: worker.executionLocation,
        summary: worker.summary,
      });
    }
    return worker;
  }

  async listMailboxMessages(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId?: string;
    readonly direction?: RuntimeMailboxMessage["direction"];
    readonly status?: RuntimeMailboxMessage["status"];
    readonly limit?: number;
  }): Promise<readonly RuntimeMailboxMessage[]> {
    if (!this.mailbox) return [];
    let workerId: string | undefined;
    if (params.workerIdOrSessionId) {
      workerId = (
        await this.resolveWorkerByAlias({
          parentSessionId: params.parentSessionId,
          workerIdOrSessionId: params.workerIdOrSessionId,
        })
      )?.workerId;
      if (!workerId) {
        return [];
      }
    }
    return this.mailbox.listMessages({
      parentSessionId: params.parentSessionId,
      ...(workerId ? { workerId } : {}),
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    });
  }

  async acknowledgeMailboxMessage(params: {
    readonly parentSessionId: string;
    readonly messageId: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    if (!this.mailbox) return undefined;
    const message = await this.mailbox.getMessage(params);
    if (!message) return undefined;
    if (message.direction === "worker_to_parent" && message.type !== "permission_request") {
      return this.mailbox.markHandled(params);
    }
    return this.mailbox.acknowledgeMessage(params);
  }

  async respondToPermissionRequest(params: {
    readonly parentSessionId: string;
    readonly messageId: string;
    readonly disposition: ApprovalDisposition;
    readonly approvedBy?: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    if (!this.mailbox) return undefined;
    const requestMessage = await this.mailbox.getMessage({
      parentSessionId: params.parentSessionId,
      messageId: params.messageId,
    });
    if (!requestMessage || requestMessage.type !== "permission_request") {
      return undefined;
    }
    await this.mailbox.acknowledgeMessage({
      parentSessionId: params.parentSessionId,
      messageId: requestMessage.messageId,
    });
    const response = await this.mailbox.sendToWorker({
      type: "permission_response",
      parentSessionId: params.parentSessionId,
      workerId: requestMessage.workerId,
      approvalRequestId: requestMessage.approvalRequestId,
      disposition: params.disposition,
      ...(params.approvedBy ? { approvedBy: params.approvedBy } : {}),
      correlationId: requestMessage.messageId,
      ...(requestMessage.taskId ? { taskId: requestMessage.taskId } : {}),
    });
    void this.scheduleWorker(params.parentSessionId, requestMessage.workerId);
    return response;
  }

  async sendCoordinatorMessage(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId: string;
    readonly subject?: string;
    readonly body: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    if (!this.mailbox) return undefined;
    const worker = await this.resolveWorkerByAlias({
      parentSessionId: params.parentSessionId,
      workerIdOrSessionId: params.workerIdOrSessionId,
    });
    if (!worker) return undefined;
    const message = await this.mailbox.sendToWorker({
      type: "mode_change",
      parentSessionId: params.parentSessionId,
      workerId: worker.workerId,
      body: params.body,
      ...(params.subject ? { subject: params.subject } : {}),
    });
    void this.scheduleWorker(params.parentSessionId, worker.workerId);
    return message;
  }

  async stopWorker(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId: string;
  }): Promise<RuntimeWorkerHandle | undefined> {
    const resolved = await this.resolveWorkerByAlias({
      parentSessionId: params.parentSessionId,
      workerIdOrSessionId: params.workerIdOrSessionId,
    });
    if (!resolved) {
      return undefined;
    }

    if (this.mailbox) {
      await this.mailbox.sendToWorker({
        type: "shutdown_request",
        parentSessionId: params.parentSessionId,
        workerId: resolved.workerId,
        reason: "Coordinator stop requested.",
      });
    }

    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const record = registry.workers.find((entry) => entry.workerId === resolved.workerId);
        if (!record) {
          return undefined;
        }
        record.stopRequested = true;
        record.summary = "Worker shutdown requested.";
        record.updatedAt = this.now();
        if (!record.currentTaskId) {
          record.state = "cancelled";
        }
        return cloneWorkerRecord(record);
      },
    );
    if (!worker) {
      return undefined;
    }
    await this.emitTraceEvent({
      type: "stop_requested",
      parentSessionId: params.parentSessionId,
      workerId: worker.workerId,
      workerState: worker.state,
      summary: worker.summary,
    });

    const tasks = await this.taskStore.listTasks(params.parentSessionId);
    await Promise.all(
      tasks
        .filter((task) => task.kind === "worker_assignment")
        .map(async (task) => {
          const metadata = extractWorkerAssignmentMetadata(task);
          if (metadata?.targetWorkerId !== worker.workerId) {
            return;
          }
          if (task.id === worker.currentTaskId) {
            return;
          }
          await this.taskStore.updateTask(params.parentSessionId, task.id, {
            status: "pending",
            owner: null,
            metadata: {
              [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
                assignment: metadata.assignment,
              }),
            },
          });
          await this.emitTraceEvent({
            type: "recovered_requeue",
            parentSessionId: params.parentSessionId,
            workerId: worker.workerId,
            taskId: task.id,
            workerState: worker.state,
            reason: "worker_stop_requested",
          });
        }),
    );

    if (worker.activeSubagentSessionId) {
      this.subAgentManager.cancel(worker.activeSubagentSessionId);
    }

    const finalizedWorker = await this.finalizeWorkerExecutionLocation({
      parentSessionId: params.parentSessionId,
      workerId: worker.workerId,
    });
    if (finalizedWorker && finalizedWorker.state === "cancelled") {
      await this.emitTraceEvent({
        type: "stopped",
        parentSessionId: params.parentSessionId,
        workerId: finalizedWorker.workerId,
        workerState: finalizedWorker.state,
        summary: finalizedWorker.summary,
        executionLocation: finalizedWorker.executionLocation,
      });
    }

    return buildRuntimeWorkerHandle({
      worker: finalizedWorker ?? worker,
      pendingTaskCount: await this.countPendingAssignments(
        params.parentSessionId,
        worker.workerId,
      ),
      ...(this.mailbox
        ? await this.mailbox.getWorkerMailboxCounts({
            parentSessionId: params.parentSessionId,
            workerId: worker.workerId,
          })
        : {}),
    });
  }

  private async updateWorker(
    parentSessionId: string,
    workerId: string,
    mutate: (worker: PersistentWorkerRecord) => void,
  ): Promise<PersistentWorkerRecord | undefined> {
    return this.mutateRegistry(parentSessionId, async (registry) => {
      const record = registry.workers.find((entry) => entry.workerId === workerId);
      if (!record) return undefined;
      mutate(record);
      record.updatedAt = this.now();
      return cloneWorkerRecord(record);
    });
  }

  private getPendingApprovalRequest(
    parentSessionId: string,
    childSessionId: string,
  ): ApprovalRequest | undefined {
    return this.approvalEngine?.getPending().find((request) =>
      request.parentSessionId === parentSessionId &&
      request.subagentSessionId === childSessionId
    );
  }

  private formatCoordinatorNote(message: RuntimeMailboxMessage): string | undefined {
    if (message.type !== "mode_change") return undefined;
    const subject = message.subject?.trim();
    const body = message.body.trim();
    if (!body) return undefined;
    return subject ? `${subject}: ${body}` : body;
  }

  private async emitMailboxMessage(
    message:
      | {
          readonly type: "idle_notification";
          readonly parentSessionId: string;
          readonly workerId: string;
          readonly summary: string;
        }
      | {
          readonly type: "worker_summary";
          readonly parentSessionId: string;
          readonly workerId: string;
          readonly state: PersistentWorkerState;
          readonly summary: string;
          readonly taskId?: string;
        }
      | {
          readonly type: "verifier_result";
          readonly parentSessionId: string;
          readonly workerId: string;
          readonly overall: RuntimeVerifierVerdict["overall"];
          readonly summary?: string;
          readonly taskId?: string;
        }
      | {
          readonly type: "permission_request";
          readonly parentSessionId: string;
          readonly workerId: string;
          readonly approvalRequest: ApprovalRequest;
          readonly taskId?: string;
        },
  ): Promise<RuntimeMailboxMessage | undefined> {
    if (!this.mailbox) return undefined;
    switch (message.type) {
      case "idle_notification":
        return this.mailbox.sendToParent({
          type: "idle_notification",
          parentSessionId: message.parentSessionId,
          workerId: message.workerId,
          summary: message.summary,
        });
      case "worker_summary":
        return this.mailbox.sendToParent({
          type: "worker_summary",
          parentSessionId: message.parentSessionId,
          workerId: message.workerId,
          state: message.state,
          summary: message.summary,
          ...(message.taskId ? { taskId: message.taskId } : {}),
        });
      case "verifier_result":
        return this.mailbox.sendToParent({
          type: "verifier_result",
          parentSessionId: message.parentSessionId,
          workerId: message.workerId,
          overall: message.overall,
          ...(message.summary ? { summary: message.summary } : {}),
          ...(message.taskId ? { taskId: message.taskId } : {}),
        });
      case "permission_request":
        return this.mailbox.sendToParent({
          type: "permission_request",
          parentSessionId: message.parentSessionId,
          workerId: message.workerId,
          approvalRequestId: message.approvalRequest.id,
          message: message.approvalRequest.message,
          ...(message.taskId ? { taskId: message.taskId } : {}),
          ...(message.approvalRequest.toolName
            ? { toolName: message.approvalRequest.toolName }
            : {}),
          ...(message.approvalRequest.subagentSessionId
            ? { subagentSessionId: message.approvalRequest.subagentSessionId }
            : {}),
          ...(message.approvalRequest.approverGroup
            ? { approverGroup: message.approvalRequest.approverGroup }
            : {}),
          ...(message.approvalRequest.requiredApproverRoles
            ? {
                requiredApproverRoles:
                  message.approvalRequest.requiredApproverRoles,
              }
            : {}),
        });
    }
  }

  private async ensurePermissionRequestMessage(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly approvalRequest: ApprovalRequest;
    readonly taskId?: string;
  }): Promise<RuntimePermissionRequestMessage | undefined> {
    if (!this.mailbox) return undefined;
    const existing = (await this.mailbox.listMessages({
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      direction: "worker_to_parent",
    })).find(
      (message): message is RuntimePermissionRequestMessage =>
        message.type === "permission_request" &&
        message.approvalRequestId === params.approvalRequest.id &&
        message.status !== "handled",
    );
    if (existing) {
      return existing;
    }
    const created = await this.emitMailboxMessage({
      type: "permission_request",
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      approvalRequest: params.approvalRequest,
      ...(params.taskId ? { taskId: params.taskId } : {}),
    });
    return created?.type === "permission_request" ? created : undefined;
  }

  private async markPermissionRequestHandled(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly approvalRequestId: string;
  }): Promise<void> {
    if (!this.mailbox) return;
    const openMessages = await this.mailbox.listMessages({
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      direction: "worker_to_parent",
    });
    for (const message of openMessages) {
      if (
        message.type === "permission_request" &&
        message.approvalRequestId === params.approvalRequestId &&
        message.status !== "handled"
      ) {
        await this.mailbox.markHandled({
          parentSessionId: params.parentSessionId,
          messageId: message.messageId,
        });
      }
    }
  }

  private async markPermissionMessagesHandledForSubagent(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly childSessionId: string;
  }): Promise<void> {
    if (!this.mailbox) return;
    const messages = await this.mailbox.listMessages({
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      direction: "worker_to_parent",
    });
    for (const message of messages) {
      if (
        message.type === "permission_request" &&
        message.subagentSessionId === params.childSessionId &&
        message.status !== "handled"
      ) {
        await this.mailbox.markHandled({
          parentSessionId: params.parentSessionId,
          messageId: message.messageId,
        });
      }
    }
  }

  private async markAssignmentMessageHandled(params: {
    readonly parentSessionId: string;
    readonly messageId?: string;
  }): Promise<void> {
    if (!this.mailbox || !params.messageId) return;
    await this.mailbox.markHandled({
      parentSessionId: params.parentSessionId,
      messageId: params.messageId,
    });
  }

  private async processControlMailboxMessage(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly message: RuntimeMailboxMessage;
  }): Promise<void> {
    if (!this.mailbox) return;
    switch (params.message.type) {
      case "permission_response": {
        if (this.approvalEngine) {
          await this.approvalEngine.resolve(params.message.approvalRequestId, {
            requestId: params.message.approvalRequestId,
            disposition: params.message.disposition,
            ...(params.message.approvedBy
              ? { approvedBy: params.message.approvedBy }
              : {}),
          });
        }
        await this.mailbox.markHandled({
          parentSessionId: params.parentSessionId,
          messageId: params.message.messageId,
        });
        if (params.message.correlationId) {
          await this.mailbox.markHandled({
            parentSessionId: params.parentSessionId,
            messageId: params.message.correlationId,
          });
        } else {
          await this.markPermissionRequestHandled({
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            approvalRequestId: params.message.approvalRequestId,
          });
        }
        await this.emitTraceEvent({
          type: "permission_resolved",
          parentSessionId: params.parentSessionId,
          workerId: params.workerId,
          ...(params.message.taskId ? { taskId: params.message.taskId } : {}),
          reason: params.message.disposition,
        });
        return;
      }
      case "mode_change": {
        const note = this.formatCoordinatorNote(params.message);
        await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
          if (note) {
            worker.queuedCoordinatorNotes = [
              ...(worker.queuedCoordinatorNotes ?? []),
              note,
            ];
          }
        });
        await this.mailbox.markHandled({
          parentSessionId: params.parentSessionId,
          messageId: params.message.messageId,
        });
        return;
      }
      case "shutdown_request": {
        const shutdownMessage = params.message;
        const worker = await this.updateWorker(
          params.parentSessionId,
          params.workerId,
          (record) => {
            record.stopRequested = true;
            record.summary = shutdownMessage.reason?.trim().length
              ? shutdownMessage.reason
              : "Worker shutdown requested.";
            if (!record.currentTaskId) {
              record.state = "cancelled";
            }
          },
        );
        if (worker?.activeSubagentSessionId) {
          this.subAgentManager.cancel(worker.activeSubagentSessionId);
        }
        await this.mailbox.markHandled({
          parentSessionId: params.parentSessionId,
          messageId: params.message.messageId,
        });
        if (worker && !worker.currentTaskId) {
          const finalizedWorker = await this.finalizeWorkerExecutionLocation({
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
          });
          await this.emitMailboxMessage({
            type: "worker_summary",
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            state: "cancelled",
            summary:
              finalizedWorker?.summary ??
              worker.summary ??
              "Worker stopped.",
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async claimNextAssignment(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
  }): Promise<
    | {
        readonly task: Task;
        readonly metadata: WorkerAssignmentMetadata;
      }
    | undefined
  > {
    const pendingTasks = await this.taskStore.listTasks(params.parentSessionId, {
      status: "pending",
    });
    for (const task of pendingTasks) {
      if (task.kind !== "worker_assignment" || task.blockedBy.length > 0) {
        continue;
      }
      const metadata = extractWorkerAssignmentMetadata(task);
      if (!metadata) continue;
      if (
        metadata.targetWorkerId !== undefined &&
        metadata.targetWorkerId !== params.workerId
      ) {
        continue;
      }
      const claimed = await this.taskStore.claimTask({
        listId: params.parentSessionId,
        taskId: task.id,
        owner: params.workerId,
        summary: `Claimed by ${params.workerId}.`,
      });
      if (claimed) {
        return { task: claimed, metadata };
      }
    }
    return undefined;
  }

  private async claimAssignmentTask(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly taskId: string;
  }): Promise<
    | {
        readonly task: Task;
        readonly metadata: WorkerAssignmentMetadata;
      }
    | undefined
  > {
    const task = await this.taskStore.getTask(params.parentSessionId, params.taskId);
    if (
      !task ||
      task.kind !== "worker_assignment" ||
      task.blockedBy.length > 0
    ) {
      return undefined;
    }
    const metadata = extractWorkerAssignmentMetadata(task);
    if (!metadata) return undefined;
    if (
      metadata.targetWorkerId !== undefined &&
      metadata.targetWorkerId !== params.workerId
    ) {
      return undefined;
    }
    const claimed = await this.taskStore.claimTask({
      listId: params.parentSessionId,
      taskId: params.taskId,
      owner: params.workerId,
      summary: `Claimed by ${params.workerId}.`,
    });
    if (!claimed) {
      return undefined;
    }
    return {
      task: claimed,
      metadata,
    };
  }

  private async finalizeAssignmentTask(params: {
    readonly parentSessionId: string;
    readonly taskId: string;
    readonly childSessionId: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
    readonly executionLocation?: RuntimeExecutionLocation;
    readonly remoteSessionHandleId?: string;
    readonly childResult: import("./sub-agent.js").SubAgentResult;
  }): Promise<{
    readonly terminalStatus: "completed" | "failed" | "cancelled" | "timed_out";
    readonly failureReason?: string;
  }> {
    const terminalOutcome = resolveDelegatedTerminalOutcome({
      surface: "direct_child",
      workerSessionId: params.childSessionId,
      taskId: params.taskId,
      completionState: params.childResult.completionState,
      completionProgress: params.childResult.completionProgress,
      stopReason: params.childResult.stopReason,
      stopReasonDetail: params.childResult.stopReasonDetail,
      validationCode: params.childResult.validationCode,
      reportedStatus: this.subAgentManager.getInfo(params.childSessionId)?.status,
      verifierRequirement: params.assignment.verifierRequirement,
      executionLocation: params.executionLocation,
      executionEnvelopeFingerprint:
        params.childResult.contractFingerprint ??
        params.assignment.executionEnvelopeFingerprint,
      continuationSessionId: params.childSessionId,
      ownedArtifacts: params.assignment.ownedArtifacts,
    });

    if (terminalOutcome.success) {
      await this.taskStore.finalizeRuntimeTask({
        listId: params.parentSessionId,
        taskId: params.taskId,
        status: "completed",
        summary: "Worker assignment completed successfully.",
        output: params.childResult.output,
        runtimeResult: terminalOutcome.runtimeResult,
        usage:
          params.childResult.tokenUsage as unknown as Record<string, unknown> | undefined,
        ownedArtifacts: params.assignment.ownedArtifacts,
        workingDirectory: params.assignment.workingDirectory,
        isolation:
          params.assignment.admittedInput.delegationAdmission?.isolationReason,
        executionLocation: params.executionLocation,
        externalRef: {
          kind:
            params.executionLocation?.mode === "remote_session"
              ? "remote_session"
              : "subagent",
          id: params.remoteSessionHandleId ?? params.childSessionId,
          ...(params.executionLocation?.mode === "remote_session"
            ? {}
            : { sessionId: params.childSessionId }),
        },
        eventData: {
          durationMs: params.childResult.durationMs,
          toolCalls: params.childResult.toolCalls.length,
          childSessionId: params.childSessionId,
          runtimeResult: terminalOutcome.runtimeResult,
        },
      });
      return {
        terminalStatus: "completed",
      };
    }

    const summary =
      terminalOutcome.failureReason ??
      params.childResult.output.split(/\r?\n/, 1)[0] ??
      "Worker assignment failed.";
    await this.taskStore.finalizeRuntimeTask({
      listId: params.parentSessionId,
      taskId: params.taskId,
      status:
        terminalOutcome.terminalStatus === "cancelled" ? "cancelled" : "failed",
      summary,
      output: params.childResult.output,
      runtimeResult: terminalOutcome.runtimeResult,
      usage:
        params.childResult.tokenUsage as unknown as Record<string, unknown> | undefined,
      ownedArtifacts: params.assignment.ownedArtifacts,
      workingDirectory: params.assignment.workingDirectory,
      isolation:
        params.assignment.admittedInput.delegationAdmission?.isolationReason,
      executionLocation: params.executionLocation,
      externalRef: {
        kind:
          params.executionLocation?.mode === "remote_session"
            ? "remote_session"
            : "subagent",
        id: params.remoteSessionHandleId ?? params.childSessionId,
        ...(params.executionLocation?.mode === "remote_session"
          ? {}
          : { sessionId: params.childSessionId }),
      },
      eventData: {
        durationMs: params.childResult.durationMs,
        toolCalls: params.childResult.toolCalls.length,
        childSessionId: params.childSessionId,
        runtimeResult: terminalOutcome.runtimeResult,
      },
    });
    return {
      terminalStatus: terminalOutcome.terminalStatus,
      failureReason: summary,
    };
  }

  private async executeClaimedAssignment(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly task: Task;
    readonly metadata: WorkerAssignmentMetadata;
    readonly assignmentMessageId?: string;
  }): Promise<void> {
    const assignment = params.metadata.assignment;
    const currentWorker = await this.getWorkerRecord(
      params.parentSessionId,
      params.workerId,
    );
    const executionLocation = currentWorker?.executionLocation;
    const translatedAssignment = this.translateAssignmentForExecution(
      assignment,
      executionLocation,
    );
    await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
      worker.currentTaskId = params.task.id;
      worker.state = assignment.verifierRequirement?.required === true
        ? "verifying"
        : "running";
      worker.summary = `Running ${assignment.objective}.`;
    });
    await this.emitTraceEvent({
      type: "assignment_claimed",
      parentSessionId: params.parentSessionId,
      workerId: params.workerId,
      taskId: params.task.id,
      workerState: assignment.verifierRequirement?.required === true
        ? "verifying"
        : "running",
      summary: `Running ${assignment.objective}.`,
      executionLocation,
    });
    if (assignment.verifierRequirement?.required === true) {
      await this.emitTraceEvent({
        type: "verifier_started",
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        taskId: params.task.id,
        workerState: "verifying",
        executionLocation,
      });
    }

    let childSessionId: string;
    try {
      const basePrompt = buildDelegatedChildPrompt(assignment.admittedInput, {
        continuationAuthorized: Boolean(currentWorker?.continuationSessionId),
        workingDirectory:
          translatedAssignment.workingDirectory ?? assignment.workingDirectory,
      });
      const coordinatorNotes = (currentWorker?.queuedCoordinatorNotes ?? [])
        .map((note) => note.trim())
        .filter((note) => note.length > 0);
      const childPrompt = coordinatorNotes.length > 0
        ? `${basePrompt}\n\nCoordinator messages:\n${coordinatorNotes.map((note) => `- ${note}`).join("\n")}`
        : basePrompt;
      childSessionId = await this.subAgentManager.spawn({
        parentSessionId: params.parentSessionId,
        ...(assignment.shellProfile
          ? { shellProfile: assignment.shellProfile }
          : {}),
        task: assignment.objective,
        prompt: childPrompt,
        ...(currentWorker?.continuationSessionId
          ? { continuationSessionId: currentWorker.continuationSessionId }
          : {}),
        ...(translatedAssignment.workingDirectory
          ? { workingDirectory: translatedAssignment.workingDirectory }
          : {}),
        ...(translatedAssignment.admittedInput.executionContext?.workspaceRoot
          ? { workingDirectorySource: "execution_envelope" as const }
          : {}),
        tools: assignment.allowedTools,
        ...(assignment.request.requiredToolCapabilities
          ? { requiredCapabilities: assignment.request.requiredToolCapabilities }
          : {}),
        delegationSpec: translatedAssignment.admittedInput,
        requireToolCall: specRequiresSuccessfulToolEvidence(
          assignment.admittedInput,
        ),
        ...(assignment.verifierRequirement
          ? { verifierRequirement: assignment.verifierRequirement }
          : {}),
        unsafeBenchmarkMode: assignment.unsafeBenchmarkMode === true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markAssignmentMessageHandled({
        parentSessionId: params.parentSessionId,
        messageId: params.assignmentMessageId,
      });
      await this.taskStore.finalizeRuntimeTask({
        listId: params.parentSessionId,
        taskId: params.task.id,
        status: "failed",
        summary: `Worker assignment could not start: ${message}`,
        workingDirectory: assignment.workingDirectory,
        isolation:
          assignment.admittedInput.delegationAdmission?.isolationReason,
        executionLocation,
        ...(currentWorker?.executionLocation?.mode === "remote_session" &&
          currentWorker.remoteSessionHandleId
          ? {
              externalRef: {
                kind: "remote_session" as const,
                id: currentWorker.remoteSessionHandleId,
              },
            }
          : {}),
        eventData: { stage: "spawn" },
      });
      await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
        worker.currentTaskId = undefined;
        worker.lastTaskId = params.task.id;
        worker.state = "idle";
        worker.summary = `Assignment failed to start: ${message}`;
      });
      await this.emitTraceEvent({
        type: "failed",
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        taskId: params.task.id,
        workerState: "failed",
        summary: `Assignment failed to start: ${message}`,
        executionLocation,
        reason: message,
      });
      await this.emitMailboxMessage({
        type: "worker_summary",
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        state: "failed",
        summary: `Assignment failed to start: ${message}`,
        taskId: params.task.id,
      });
      await this.emitMailboxMessage({
        type: "idle_notification",
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        summary: "Worker ready for assignments.",
      });
      return;
    }

    await this.reportRemoteSessionProgress({
      worker: currentWorker,
      state: "running",
      summary: `Running ${assignment.objective}.`,
      artifacts: assignment.ownedArtifacts,
    });

    await this.taskStore.attachExternalRef(
      params.parentSessionId,
      params.task.id,
      {
        kind:
          currentWorker?.executionLocation?.mode === "remote_session"
            ? "remote_session"
            : "subagent",
        id:
          currentWorker?.remoteSessionHandleId ??
          childSessionId,
        ...(currentWorker?.executionLocation?.mode === "remote_session"
          ? {}
          : { sessionId: childSessionId }),
      },
      "Worker assignment started.",
    );
    await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
      worker.activeSubagentSessionId = childSessionId;
      worker.continuationSessionId = childSessionId;
      worker.state = assignment.verifierRequirement?.required === true
        ? "verifying"
        : "running";
      worker.queuedCoordinatorNotes = [];
      worker.summary = `Running ${assignment.objective}.`;
    });

    while (true) {
      const childResult = this.subAgentManager.getResult(childSessionId);
      if (childResult) {
        const finalized = await this.finalizeAssignmentTask({
          parentSessionId: params.parentSessionId,
          taskId: params.task.id,
          childSessionId,
          assignment,
          executionLocation,
          remoteSessionHandleId: currentWorker?.remoteSessionHandleId,
          childResult,
        });
        await this.markAssignmentMessageHandled({
          parentSessionId: params.parentSessionId,
          messageId: params.assignmentMessageId,
        });
        await this.markPermissionMessagesHandledForSubagent({
          parentSessionId: params.parentSessionId,
          workerId: params.workerId,
          childSessionId,
        });
        await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
          worker.currentTaskId = undefined;
          worker.lastTaskId = params.task.id;
          worker.activeSubagentSessionId = undefined;
          worker.continuationSessionId = childSessionId;
          if (worker.stopRequested) {
            worker.state = "cancelled";
            worker.summary = "Worker stopped.";
          } else {
            worker.state = "idle";
            worker.summary =
              finalized.terminalStatus === "completed"
                ? `Completed ${assignment.objective}.`
                : finalized.failureReason ?? `Assignment ${finalized.terminalStatus}.`;
          }
        });
        const finalState = (await this.getWorkerRecord(
          params.parentSessionId,
          params.workerId,
        ))?.state ?? "idle";
        let finalSummary = (await this.getWorkerRecord(
          params.parentSessionId,
          params.workerId,
        ))?.summary ?? `Completed ${assignment.objective}.`;
        if (
          finalState === "completed" ||
          finalState === "failed" ||
          finalState === "cancelled"
        ) {
          const finalizedWorker = await this.finalizeWorkerExecutionLocation({
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
          });
          if (finalizedWorker?.summary) {
            finalSummary = finalizedWorker.summary;
          }
        }
        await this.emitMailboxMessage({
          type: "worker_summary",
          parentSessionId: params.parentSessionId,
          workerId: params.workerId,
          state: finalState,
          summary: finalSummary,
          taskId: params.task.id,
        });
        if (finalState === "idle") {
          await this.emitTraceEvent({
            type: "idle",
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            taskId: params.task.id,
            workerState: "idle",
            summary: finalSummary,
            executionLocation: (
              await this.getWorkerRecord(params.parentSessionId, params.workerId)
            )?.executionLocation,
          });
          await this.reportRemoteSessionProgress({
            worker: await this.getWorkerRecord(
              params.parentSessionId,
              params.workerId,
            ),
            state: "running",
            summary: finalSummary,
            artifacts: assignment.ownedArtifacts,
          });
          await this.emitMailboxMessage({
            type: "idle_notification",
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            summary: "Worker ready for assignments.",
          });
        }
        return;
      }

      if (this.mailbox) {
        const controlMessage = await this.mailbox.claimNextWorkerMessage({
          parentSessionId: params.parentSessionId,
          workerId: params.workerId,
          types: ["permission_response", "shutdown_request", "mode_change"],
        });
        if (controlMessage) {
          await this.processControlMailboxMessage({
            parentSessionId: params.parentSessionId,
            workerId: params.workerId,
            message: controlMessage,
          });
        }
      }

      const approvalRequest = this.getPendingApprovalRequest(
        params.parentSessionId,
        childSessionId,
      );
      if (approvalRequest) {
        await this.ensurePermissionRequestMessage({
          parentSessionId: params.parentSessionId,
          workerId: params.workerId,
          approvalRequest,
          taskId: params.task.id,
        });
      }
      const approvalPending = Boolean(approvalRequest);
      const nextState: PersistentWorkerState = approvalPending
        ? "waiting_for_permission"
        : assignment.verifierRequirement?.required === true
          ? "verifying"
          : "running";
      await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
        worker.activeSubagentSessionId = childSessionId;
        worker.state = nextState;
        worker.summary = approvalPending
          ? `Waiting for approval on ${assignment.objective}.`
          : `Running ${assignment.objective}.`;
      });
      await this.emitTraceEvent({
        type: approvalPending ? "permission_blocked" : "permission_resolved",
        parentSessionId: params.parentSessionId,
        workerId: params.workerId,
        taskId: params.task.id,
        workerState: nextState,
        summary: approvalPending
          ? `Waiting for approval on ${assignment.objective}.`
          : `Running ${assignment.objective}.`,
        executionLocation,
      });
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async runWorkerLoop(
    parentSessionId: string,
    workerId: string,
  ): Promise<void> {
    while (true) {
      const worker = await this.getWorkerRecord(parentSessionId, workerId);
      if (!worker || isTerminalWorkerState(worker.state)) {
        return;
      }
      if (worker.stopRequested && !worker.currentTaskId) {
        await this.updateWorker(parentSessionId, workerId, (record) => {
          record.state = "cancelled";
          record.summary = "Worker stopped.";
        });
        const finalizedWorker = await this.finalizeWorkerExecutionLocation({
          parentSessionId,
          workerId,
        });
        await this.emitTraceEvent({
          type: "stopped",
          parentSessionId,
          workerId,
          workerState: finalizedWorker?.state ?? "cancelled",
          summary: finalizedWorker?.summary ?? "Worker stopped.",
          executionLocation: finalizedWorker?.executionLocation,
        });
        await this.emitMailboxMessage({
          type: "worker_summary",
          parentSessionId,
          workerId,
          state: "cancelled",
          summary: finalizedWorker?.summary ?? "Worker stopped.",
        });
        return;
      }

      if (this.mailbox) {
        const mailboxMessage = await this.mailbox.claimNextWorkerMessage({
          parentSessionId,
          workerId,
          types: [
            "task_assignment",
            "permission_response",
            "shutdown_request",
            "mode_change",
          ],
        });
        if (mailboxMessage) {
          if (mailboxMessage.type === "task_assignment") {
            const claim = await this.claimAssignmentTask({
              parentSessionId,
              workerId,
              taskId: mailboxMessage.taskId,
            });
            if (!claim) {
              await this.mailbox.markHandled({
                parentSessionId,
                messageId: mailboxMessage.messageId,
              });
              continue;
            }
            await this.executeClaimedAssignment({
              parentSessionId,
              workerId,
              task: claim.task,
              metadata: claim.metadata,
              assignmentMessageId: mailboxMessage.messageId,
            });
            continue;
          }
          await this.processControlMailboxMessage({
            parentSessionId,
            workerId,
            message: mailboxMessage,
          });
          continue;
        }

        await this.updateWorker(parentSessionId, workerId, (record) => {
          if (!record.stopRequested) {
            record.state = "idle";
            record.summary = "Worker ready for assignments.";
          }
        });
        await this.emitTraceEvent({
          type: "idle",
          parentSessionId,
          workerId,
          workerState: "idle",
          summary: "Worker ready for assignments.",
          executionLocation: (await this.getWorkerRecord(parentSessionId, workerId))
            ?.executionLocation,
        });
        await this.emitMailboxMessage({
          type: "idle_notification",
          parentSessionId,
          workerId,
          summary: "Worker ready for assignments.",
        });
        return;
      }

      const claim = await this.claimNextAssignment({
        parentSessionId,
        workerId,
      });
      if (!claim) {
      await this.updateWorker(parentSessionId, workerId, (record) => {
        if (!record.stopRequested) {
          record.state = "idle";
          record.summary = "Worker ready for assignments.";
        }
      });
      await this.emitTraceEvent({
        type: "idle",
        parentSessionId,
        workerId,
        workerState: "idle",
        summary: "Worker ready for assignments.",
        executionLocation: (await this.getWorkerRecord(parentSessionId, workerId))
          ?.executionLocation,
      });
      return;
      }

      await this.executeClaimedAssignment({
        parentSessionId,
        workerId,
        task: claim.task,
        metadata: claim.metadata,
      });
    }
  }

  async scheduleWorker(parentSessionId: string, workerId: string): Promise<void> {
    await this.queue.run(this.workerLoopKey(parentSessionId, workerId), async () => {
      await this.runWorkerLoop(parentSessionId, workerId);
    });
  }

  async repairRuntimeState(): Promise<void> {
    if (this.mailbox) {
      await this.mailbox.repairRuntimeState();
    }
    const keys = await this.memoryBackend.listKeys(PERSISTENT_WORKER_KEY_PREFIX);
    for (const key of keys) {
      const parentSessionId = key.slice(PERSISTENT_WORKER_KEY_PREFIX.length);
      const registry = await this.loadRegistry(parentSessionId);
      const affectedWorkerIds = registry.workers
        .filter((worker) => !isTerminalWorkerState(worker.state))
        .map((worker) => worker.workerId);
      if (affectedWorkerIds.length === 0) {
        continue;
      }
      await this.mutateRegistry(parentSessionId, async (mutableRegistry) => {
        for (const worker of mutableRegistry.workers) {
          if (affectedWorkerIds.includes(worker.workerId)) {
            worker.state = "failed";
            worker.stopRequested = true;
            worker.currentTaskId = undefined;
            worker.activeSubagentSessionId = undefined;
            worker.summary =
              "Worker runtime became unavailable before completion.";
            worker.updatedAt = this.now();
          }
        }
      });
      for (const workerId of affectedWorkerIds) {
        const finalizedWorker = await this.finalizeWorkerExecutionLocation({
          parentSessionId,
          workerId,
        });
        await this.emitTraceEvent({
          type: "failed",
          parentSessionId,
          workerId,
          workerState: finalizedWorker?.state ?? "failed",
          summary:
            finalizedWorker?.summary ??
            "Worker runtime became unavailable before completion.",
          executionLocation: finalizedWorker?.executionLocation,
          reason: "runtime_repair",
        });
      }
      const tasks = await this.taskStore.listTasks(parentSessionId);
      for (const task of tasks) {
        if (task.kind !== "worker_assignment") continue;
        const metadata = extractWorkerAssignmentMetadata(task);
        if (!metadata) continue;
        const targetedWorkerId = metadata.targetWorkerId;
        if (
          (task.owner && affectedWorkerIds.includes(task.owner)) ||
          (targetedWorkerId && affectedWorkerIds.includes(targetedWorkerId))
        ) {
          await this.taskStore.updateTask(parentSessionId, task.id, {
            status: "pending",
            owner: null,
            metadata: {
              [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
                assignment: metadata.assignment,
              }),
            },
          });
          await this.emitTraceEvent({
            type: "recovered_requeue",
            parentSessionId,
            workerId: targetedWorkerId ?? task.owner ?? "unknown",
            taskId: task.id,
            reason: "runtime_repair",
          });
        }
      }
    }
  }

  async describeRuntimeMailboxLayer(
    parentSessionId: string,
    configured: boolean,
  ): Promise<RuntimeMailboxLayerSnapshot> {
    if (!configured) {
      return {
        configured: false,
        effective: false,
        pendingParentToWorker: 0,
        pendingWorkerToParent: 0,
        unackedCount: 0,
        inactiveReason: "flag_disabled",
      };
    }
    if (!this.mailbox) {
      return {
        configured: true,
        effective: false,
        pendingParentToWorker: 0,
        pendingWorkerToParent: 0,
        unackedCount: 0,
        inactiveReason: "mailbox_manager_uninitialized",
      };
    }
    return this.mailbox.describeRuntimeMailboxLayer({
      configured,
      parentSessionId,
    });
  }

  async describeRuntimeWorkerLayer(
    parentSessionId: string,
    configured: boolean,
  ): Promise<RuntimeWorkerLayerSnapshot> {
    if (!configured) {
      return {
        configured: false,
        effective: false,
        launchMode: "none",
        activePublicWorkers: 0,
        stateCounts: {},
        inactiveReason: "flag_disabled",
      };
    }
    const workers = await this.listWorkerRecords(parentSessionId);
    const stateCounts: Partial<Record<PersistentWorkerState, number>> = {};
    const executionLocationCounts: Partial<
      Record<NonNullable<RuntimeExecutionLocation["mode"]>, number>
    > = {};
    for (const worker of workers) {
      stateCounts[worker.state] = (stateCounts[worker.state] ?? 0) + 1;
      if (worker.executionLocation?.mode) {
        executionLocationCounts[worker.executionLocation.mode] =
          (executionLocationCounts[worker.executionLocation.mode] ?? 0) + 1;
      }
    }
    return {
      configured: true,
      effective: true,
      launchMode: "persistent_worker_pool",
      activePublicWorkers: workers.filter((worker) => !isTerminalWorkerState(worker.state)).length,
      stateCounts,
      executionLocationCounts,
      ...(await this.getLatestReusableWorkerId(parentSessionId)
        ? { latestReusableWorkerId: await this.getLatestReusableWorkerId(parentSessionId) }
        : {}),
    };
  }

  async handleRuntimeReset(reason: string): Promise<void> {
    await this.repairRuntimeState();
    this.logger.debug("Persistent worker runtime reset", { reason });
  }
}
