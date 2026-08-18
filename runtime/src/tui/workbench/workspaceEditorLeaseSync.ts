import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  WorkspaceEditorAcquireParams,
  WorkspaceEditorBufferSync,
  WorkspaceEditorChangeResult,
  WorkspaceEditorChangesListParams,
  WorkspaceEditorChangesListResult,
  WorkspaceEditorHeartbeatParams,
  WorkspaceEditorLeaseResult,
  WorkspaceEditorProposalApplyParams,
  WorkspaceEditorProposalApplyResult,
  WorkspaceEditorProposalDiscardResult,
  WorkspaceEditorProposalParams,
  WorkspaceEditorProposalResult,
  WorkspaceEditorProposalStatusParams,
  WorkspaceEditorProposalStatusResult,
  WorkspaceEditorRecoveredTopologyListParams,
  WorkspaceEditorRecoveredTopologyListResult,
  WorkspaceEditorRecoveredTopologyMutation,
  WorkspaceEditorRecoveredTopologyResolveParams,
  WorkspaceEditorRecoveredTopologyResolveResult,
  WorkspaceEditorReleaseParams,
  WorkspaceEditorReleaseResult,
  WorkspaceEditorStaleAuthorityEntry,
  WorkspaceEditorStaleAuthorityRefreshParams,
  WorkspaceEditorStaleAuthorityRefreshResult,
  WorkspaceEditorSyncParams,
  WorkspaceEditorSyncResult,
  WorkspaceEditorTopologyCompleteParams,
  WorkspaceEditorTopologyCompleteResult,
  WorkspaceEditorTopologyFinalizeParams,
  WorkspaceEditorTopologyReleaseResult,
  WorkspaceEditorTopologyReserveParams,
  WorkspaceEditorTopologyReserveResult,
  WorkspaceEditorTopologyTarget,
} from "../../app-server/protocol/index.js";
import type {
  BufferProviderSnapshot,
  BufferEditorProposalResolution,
  BufferProviderPathMutationResult,
  BufferWorkspaceBufferCapture,
  BufferWorkspaceWriteAuthorityHandler,
  BufferWorkspaceWriteDecision,
  BufferWorkspaceWriteRequest,
} from "./buffer/providers/types.js";
import { BufferWorkspaceCaptureUnstableError } from "./buffer/providers/types.js";

const DEFAULT_SYNC_DEBOUNCE_MS = 80;
const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_RETRY_MS = 1_500;

type AcceptedEditorProposalResolution = Extract<
  BufferEditorProposalResolution,
  { readonly ok: true }
> & {
  readonly action: "accepted";
  readonly changedtick: number;
};

type RejectedEditorProposalResolution = Extract<
  BufferEditorProposalResolution,
  { readonly ok: true }
> & {
  readonly action: "rejected";
};

export function isValidAcceptedEditorProposalResolution(
  result: BufferEditorProposalResolution,
  editorProposalId: string,
  baseChangedtick: number,
  recoveredAcceptedChangedtick?: number,
): result is AcceptedEditorProposalResolution {
  return (
    result.ok &&
    result.action === "accepted" &&
    result.proposalId === editorProposalId &&
    Number.isSafeInteger(result.changedtick) &&
    (result.changedtick! > baseChangedtick ||
      result.changedtick === recoveredAcceptedChangedtick)
  );
}

export function isValidRejectedEditorProposalResolution(
  result: BufferEditorProposalResolution,
  editorProposalId: string,
): result is RejectedEditorProposalResolution {
  return (
    result.ok &&
    result.action === "rejected" &&
    result.proposalId === editorProposalId
  );
}

export type WorkspaceEditorLeaseClient = {
  acquireWorkspaceEditor(
    params: WorkspaceEditorAcquireParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  syncWorkspaceEditor(
    params: WorkspaceEditorSyncParams,
  ): Promise<WorkspaceEditorSyncResult>;
  refreshWorkspaceEditorStaleAuthority(
    params: WorkspaceEditorStaleAuthorityRefreshParams,
  ): Promise<WorkspaceEditorStaleAuthorityRefreshResult>;
  heartbeatWorkspaceEditor(
    params: WorkspaceEditorHeartbeatParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  releaseWorkspaceEditor(
    params: WorkspaceEditorReleaseParams,
  ): Promise<WorkspaceEditorReleaseResult>;
  reserveWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyReserveParams,
  ): Promise<WorkspaceEditorTopologyReserveResult>;
  completeWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyCompleteParams,
  ): Promise<WorkspaceEditorTopologyCompleteResult>;
  releaseWorkspaceEditorTopology?(
    params: WorkspaceEditorTopologyFinalizeParams,
  ): Promise<WorkspaceEditorTopologyReleaseResult>;
  listRecoveredWorkspaceEditorTopologies?(
    params: WorkspaceEditorRecoveredTopologyListParams,
  ): Promise<WorkspaceEditorRecoveredTopologyListResult>;
  resolveRecoveredWorkspaceEditorTopology?(
    params: WorkspaceEditorRecoveredTopologyResolveParams,
  ): Promise<WorkspaceEditorRecoveredTopologyResolveResult>;
  getWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalResult>;
  getWorkspaceEditorProposalStatus?(
    params: WorkspaceEditorProposalStatusParams,
  ): Promise<WorkspaceEditorProposalStatusResult>;
  applyWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalApplyParams,
  ): Promise<WorkspaceEditorProposalApplyResult>;
  discardWorkspaceEditorProposal?(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalDiscardResult>;
  listWorkspaceEditorChanges?(
    params: WorkspaceEditorChangesListParams,
  ): Promise<WorkspaceEditorChangesListResult>;
};

export type WorkspaceEditorBufferSource = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BufferProviderSnapshot;
  captureWorkspaceBuffers(): Promise<readonly BufferWorkspaceBufferCapture[]>;
  beginProjectPathMutation?(): boolean;
  endProjectPathMutation?(): void;
  synchronizePathDelete?(
    path: string,
  ): Promise<BufferProviderPathMutationResult>;
  setWorkspaceWriteAuthorityHandler?(
    handler: BufferWorkspaceWriteAuthorityHandler | null,
  ): void;
};

export type WorkspaceEditorLeaseSynchronizerOptions = {
  readonly workspaceRoot: string;
  readonly editorInstanceId: string;
  readonly client: WorkspaceEditorLeaseClient;
  readonly buffers: WorkspaceEditorBufferSource;
  readonly onError?: (error: Error) => void;
  readonly onWorkspaceChange?: (
    change: WorkspaceEditorChangeResult,
  ) => Promise<void> | void;
  readonly onAuthorityChange?: (state: WorkspaceEditorAuthorityState) => void;
  readonly syncDebounceMs?: number;
  readonly heartbeatMs?: number;
  readonly retryMs?: number;
};

export type WorkspaceEditorAuthorityState =
  | { readonly status: "not_required" }
  | { readonly status: "securing" }
  | { readonly status: "syncing" }
  | { readonly status: "ready" }
  | {
      readonly status: "blocked";
      readonly reason: string;
      readonly recoveredTopologyMutations?: readonly WorkspaceEditorRecoveredTopologyMutation[];
      readonly staleAuthority?: readonly WorkspaceEditorStaleAuthorityEntry[];
    };

export function bufferSnapshotRequiresWorkspaceEditorAuthority(
  snapshot: Pick<
    BufferProviderSnapshot,
    "provider" | "workspaceAuthorityRequired"
  >,
): boolean {
  return (
    snapshot.provider.kind === "neovim" && snapshot.workspaceAuthorityRequired
  );
}

export interface WorkspaceEditorTopologyTransaction {
  readonly tokenId: string;
  complete(status: "applied" | "unknown_outcome"): Promise<void>;
  release(): Promise<void>;
}

const topologySynchronizers = new Map<
  string,
  WorkspaceEditorLeaseSynchronizer
>();

export async function beginWorkspaceEditorTopologyMutation(
  workspaceRoot: string,
  targets: readonly WorkspaceEditorTopologyTarget[],
): Promise<WorkspaceEditorTopologyTransaction | null> {
  const synchronizer = topologySynchronizers.get(
    workspaceTopologyKey(workspaceRoot),
  );
  if (synchronizer === undefined) return null;
  return synchronizer.beginTopologyMutation(targets);
}

export async function resolveWorkspaceEditorRecoveredTopologyMutation(
  workspaceRoot: string,
  tokenId: string,
): Promise<void> {
  const synchronizer = topologySynchronizers.get(
    workspaceTopologyKey(workspaceRoot),
  );
  if (synchronizer === undefined) {
    throw new Error("The authoritative Editor recovery session is not active.");
  }
  await synchronizer.resolveRecoveredTopologyMutation(tokenId);
}

export async function abandonWorkspaceEditorStaleAuthority(
  workspaceRoot: string,
  entries: readonly WorkspaceEditorStaleAuthorityEntry[],
): Promise<void> {
  const synchronizer = topologySynchronizers.get(
    workspaceTopologyKey(workspaceRoot),
  );
  if (synchronizer === undefined) {
    throw new Error("The authoritative Editor recovery session is not active.");
  }
  await synchronizer.abandonStaleAuthority(entries);
}

export async function refreshWorkspaceEditorStaleAuthority(
  workspaceRoot: string,
): Promise<void> {
  const synchronizer = topologySynchronizers.get(
    workspaceTopologyKey(workspaceRoot),
  );
  if (synchronizer === undefined) {
    throw new Error("The authoritative Editor recovery session is not active.");
  }
  await synchronizer.refreshStaleAuthority();
}

type PendingWorkspaceProposalAcceptance = {
  readonly proposal: WorkspaceEditorProposalResult;
  readonly editorProposalId: string;
  readonly accepted: {
    readonly ok: true;
    readonly action: "accepted";
    readonly proposalId: string;
    readonly changedtick: number;
  };
};

type PendingWorkspaceProposalRejection = {
  readonly proposal: WorkspaceEditorProposalResult;
  readonly editorProposalId: string;
  readonly rejected: {
    readonly ok: true;
    readonly action: "rejected";
    readonly proposalId: string;
  };
};

/**
 * Keeps the daemon's workspace mutation authority aligned with the exact
 * loaded Neovim revisions. The daemon never persists source content: clean
 * buffers send only hashes and dirty source remains in the in-memory lease.
 */
export class WorkspaceEditorLeaseSynchronizer {
  readonly #workspaceRoot: string;
  readonly #editorInstanceId: string;
  readonly #client: WorkspaceEditorLeaseClient;
  readonly #buffers: WorkspaceEditorBufferSource;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #onWorkspaceChange:
    ((change: WorkspaceEditorChangeResult) => Promise<void> | void) | undefined;
  readonly #onAuthorityChange:
    ((state: WorkspaceEditorAuthorityState) => void) | undefined;
  readonly #syncDebounceMs: number;
  readonly #retryMs: number;
  readonly #heartbeatMs: number;
  #lease: WorkspaceEditorLeaseResult | null = null;
  #knownLeaseIdentity: {
    readonly epoch: number;
    readonly leaseToken: string;
  } | null = null;
  #sequence = -1;
  #changeSequence = 0;
  #lastObservedManifest: string | null = null;
  #lastSyncedManifest: string | null = null;
  #lastErrorMessage: string | null = null;
  #authorityState: WorkspaceEditorAuthorityState = {
    status: "not_required",
  };
  #initialSynchronizationComplete = false;
  #started = false;
  #stopRequested = false;
  #stopped = false;
  #unsubscribe: (() => void) | null = null;
  #syncTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #syncPromise: Promise<void> | null = null;
  #syncQueued = false;
  #heartbeatPromise: Promise<void> | null = null;
  #workspaceChangePollPromise: Promise<void> | null = null;
  #workspaceWriteAuthorizationPromise: Promise<BufferWorkspaceWriteDecision> | null =
    null;
  #proposalOperationActive = false;
  #proposalOperationPromise: Promise<unknown> | null = null;
  #workspaceChangeCallbackProposalId: string | null = null;
  #topologyOperationStarting = false;
  #topologyOperation: { readonly tokenId: string } | null = null;
  #topologyFinalizePromise: Promise<void> | null = null;
  #recoveredTopologyMutations: readonly WorkspaceEditorRecoveredTopologyMutation[] =
    [];
  #recoveredTopologyResolvePromise: Promise<void> | null = null;
  #staleAuthority: readonly WorkspaceEditorStaleAuthorityEntry[] = [];
  #pendingProposalAcceptance: PendingWorkspaceProposalAcceptance | null = null;
  #pendingProposalRejection: PendingWorkspaceProposalRejection | null = null;
  #stopPreparationPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;

  constructor(options: WorkspaceEditorLeaseSynchronizerOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#editorInstanceId = options.editorInstanceId;
    this.#client = options.client;
    this.#buffers = options.buffers;
    this.#onError = options.onError;
    this.#onWorkspaceChange = options.onWorkspaceChange;
    this.#onAuthorityChange = options.onAuthorityChange;
    this.#syncDebounceMs = options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  start(): void {
    if (this.#started || this.#stopRequested || this.#stopped) return;
    this.#started = true;
    this.#buffers.setWorkspaceWriteAuthorityHandler?.((request) =>
      this.#authorizeWorkspaceWrite(request),
    );
    topologySynchronizers.set(workspaceTopologyKey(this.#workspaceRoot), this);
    this.#onAuthorityChange?.(this.#authorityState);
    this.#unsubscribe = this.#buffers.subscribe(() => this.#observe());
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, this.#heartbeatMs);
    this.#observe();
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    const attempt = (async () => {
      await this.prepareStop();
      await this.#finishStop();
    })();
    this.#stopPromise = attempt;
    void attempt.catch(() => {
      if (this.#stopPromise === attempt) this.#stopPromise = null;
    });
    return attempt;
  }

  prepareStop(): Promise<void> {
    if (this.#stopPreparationPromise !== null) {
      return this.#stopPreparationPromise;
    }
    this.#stopRequested = true;
    const attempt = this.#prepareStop();
    this.#stopPreparationPromise = attempt;
    void attempt.catch(() => {
      if (this.#stopPreparationPromise === attempt) {
        // A failed exact capture/sync is not terminal. Keep ownership and the
        // heartbeat alive, then let the shutdown barrier retry the transaction
        // once Neovim or the daemon is responsive again.
        this.#stopPreparationPromise = null;
      }
    });
    return attempt;
  }

  async beginTopologyMutation(
    targets: readonly WorkspaceEditorTopologyTarget[],
  ): Promise<WorkspaceEditorTopologyTransaction> {
    if (this.#stopRequested || this.#stopped) {
      throw new Error("Editor workspace synchronization is stopping.");
    }
    if (
      this.#workspaceWriteAuthorizationPromise !== null ||
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null
    ) {
      throw new Error(
        "Another Editor write, rename, or delete is already in progress.",
      );
    }
    const reserve = this.#client.reserveWorkspaceEditorTopology;
    const complete = this.#client.completeWorkspaceEditorTopology;
    const release = this.#client.releaseWorkspaceEditorTopology;
    if (
      reserve === undefined ||
      complete === undefined ||
      release === undefined
    ) {
      throw new Error(
        "The connected daemon cannot fence Editor project renames or deletes. Restart the daemon with this AgenC version.",
      );
    }
    this.#topologyOperationStarting = true;
    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
    this.#publishAuthority({ status: "syncing" });
    try {
      if (this.#proposalOperationPromise !== null) {
        await this.#proposalOperationPromise;
      }
      if (this.#heartbeatPromise !== null) await this.#heartbeatPromise;
      if (this.#syncPromise !== null) await this.#syncPromise;
      await this.#synchronize(true);
      const lease = this.#lease;
      if (lease === null || !this.#initialSynchronizationComplete) {
        throw new Error(
          "The authoritative Editor lease is not synchronized; retry after Editor safety sync recovers.",
        );
      }
      const result = await reserve({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        targets,
      });
      if (typeof result.tokenId !== "string" || result.tokenId.length === 0) {
        throw new Error(
          "The daemon returned a malformed Editor project-path reservation.",
        );
      }
      this.#topologyOperation = { tokenId: result.tokenId };
      this.#lastErrorMessage = null;
      const tokenId = result.tokenId;
      return {
        tokenId,
        complete: (status) =>
          this.#finalizeTopologyMutation(tokenId, "complete", status),
        release: () =>
          this.#finalizeTopologyMutation(tokenId, "release", "applied"),
      };
    } catch (cause) {
      this.#report(cause);
      if (this.#topologyOperation === null) {
        this.#lastObservedManifest = null;
        this.#observe();
      }
      throw cause;
    } finally {
      this.#topologyOperationStarting = false;
    }
  }

  async resolveRecoveredTopologyMutation(tokenId: string): Promise<void> {
    if (this.#stopRequested || this.#stopped) {
      throw new Error("Editor workspace synchronization is stopping.");
    }
    if (this.#recoveredTopologyResolvePromise !== null) {
      await this.#recoveredTopologyResolvePromise;
      return;
    }
    const recovered = this.#recoveredTopologyMutations.find(
      (mutation) => mutation.tokenId === tokenId,
    );
    if (recovered === undefined) {
      throw new Error(
        "The recovered Editor project-path fence is missing or already reconciled.",
      );
    }
    const resolveRecovered =
      this.#client.resolveRecoveredWorkspaceEditorTopology;
    if (resolveRecovered === undefined || this.#lease === null) {
      throw new Error(
        "The connected daemon cannot reconcile the recovered Editor project-path fence. Restart the daemon with this AgenC version.",
      );
    }
    const operation = (async () => {
      if (this.#heartbeatPromise !== null) {
        await this.#heartbeatPromise;
      }
      const lease = this.#lease;
      if (lease === null) {
        throw new Error(
          "The authoritative Editor lease was lost before recovered mutation reconciliation could start.",
        );
      }
      this.#publishRecoveredTopologyBlock(
        "Reconciling the interrupted Editor path operation as an audited unknown outcome…",
      );
      const beginProviderMutation = this.#buffers.beginProjectPathMutation;
      const endProviderMutation = this.#buffers.endProjectPathMutation;
      if (
        beginProviderMutation === undefined ||
        endProviderMutation === undefined ||
        !beginProviderMutation.call(this.#buffers)
      ) {
        throw new Error(
          "The active Editor provider cannot freeze project paths for recovered mutation reconciliation.",
        );
      }
      try {
        await this.#unloadRecoveredTopologyCleanTargets(recovered);
        const otherRecoveredTargets = this.#recoveredTopologyMutations
          .filter((mutation) => mutation.tokenId !== tokenId)
          .flatMap((mutation) => mutation.targets);
        const captures = (await this.#buffers.captureWorkspaceBuffers()).filter(
          (capture) =>
            !otherRecoveredTargets.some((target) =>
              recoveredTopologyTargetContainsPath(target, capture.path),
            ),
        );
        const prepared = captures.map(workspaceBufferSync);
        const sequence = this.#sequence + 1;
        const result = await resolveRecovered({
          workspaceRoot: this.#workspaceRoot,
          editorInstanceId: this.#editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
          tokenId,
          sequence,
          buffers: prepared,
        });
        if (
          result.resolved !== true ||
          result.tokenId !== tokenId ||
          result.status !== "unknown_outcome" ||
          result.sync.accepted !== true ||
          result.sync.sequence !== sequence
        ) {
          throw new Error(
            "The daemon returned a malformed recovered project-path reconciliation.",
          );
        }
        this.#sequence = result.sync.sequence;
        this.#lastSyncedManifest =
          synchronizedBufferManifestSignature(prepared);
        this.#lease = {
          ...lease,
          sequence: result.sync.sequence,
          expiresAt: result.sync.expiresAt,
        };
        this.#recoveredTopologyMutations =
          this.#recoveredTopologyMutations.filter(
            (mutation) => mutation.tokenId !== tokenId,
          );
        const stillBlocked = await this.#discoverRecoveredTopologyMutations();
        if (stillBlocked) return;
        this.#lastObservedManifest = null;
        this.#initialSynchronizationComplete = false;
        this.#publishAuthority({ status: "securing" });
        await this.#synchronize(true);
      } finally {
        endProviderMutation.call(this.#buffers);
      }
    })();
    this.#recoveredTopologyResolvePromise = operation;
    try {
      await operation;
    } catch (cause) {
      try {
        const stillBlocked = await this.#discoverRecoveredTopologyMutations();
        const tokenStillDurable = this.#recoveredTopologyMutations.some(
          (mutation) => mutation.tokenId === tokenId,
        );
        if (!tokenStillDurable) {
          // The daemon may have durably installed the combined manifest/token
          // terminal and then lost the reply (or failed only while draining
          // its append-once audit outbox). Re-listing is the idempotent receipt.
          const acquired = await this.#client.acquireWorkspaceEditor({
            workspaceRoot: this.#workspaceRoot,
            editorInstanceId: this.#editorInstanceId,
          });
          this.#acceptAcquiredLease(acquired);
          if (!stillBlocked) {
            this.#lastObservedManifest = null;
            this.#lastSyncedManifest = null;
            this.#initialSynchronizationComplete = false;
            this.#publishAuthority({ status: "securing" });
            await this.#synchronize(true);
          }
          return;
        }
      } catch {
        // Preserve the original reconciliation failure when its durable state
        // cannot be queried safely.
      }
      this.#publishRecoveredTopologyBlock(errorMessage(cause));
      this.#report(cause);
      throw cause;
    } finally {
      if (this.#recoveredTopologyResolvePromise === operation) {
        this.#recoveredTopologyResolvePromise = null;
      }
    }
  }

  async #unloadRecoveredTopologyCleanTargets(
    mutation: WorkspaceEditorRecoveredTopologyMutation,
  ): Promise<void> {
    const unloadCleanPath = this.#buffers.synchronizePathDelete;
    if (unloadCleanPath === undefined) {
      throw new Error(
        "The active Editor provider cannot safely close clean buffers for recovered mutation reconciliation.",
      );
    }
    for (;;) {
      const snapshot = this.#buffers.getSnapshot();
      const candidate = snapshot.buffers.find((buffer) => {
        if (
          !buffer.loaded ||
          buffer.bufferType !== "" ||
          buffer.absolutePath === null ||
          buffer.changedtick === null ||
          buffer.modified
        ) {
          return false;
        }
        return mutation.targets.some((target) =>
          recoveredTopologyTargetContainsPath(target, buffer.absolutePath!),
        );
      });
      if (candidate === undefined) return;
      const path = candidate.absolutePath!;
      const unloaded = await unloadCleanPath.call(this.#buffers, path);
      if (!unloaded.ok) {
        const racedDirty = this.#buffers
          .getSnapshot()
          .buffers.some(
            (buffer) =>
              buffer.loaded &&
              buffer.modified &&
              buffer.absolutePath !== null &&
              workspaceTopologyKey(buffer.absolutePath) ===
                workspaceTopologyKey(path),
          );
        if (racedDirty) {
          // A buffer that raced dirty remains Editor authority and is carried
          // in the final exact manifest; recovery must never unload it.
          continue;
        }
        throw new Error(
          `Editor could not safely close recovered clean path ${path}: ${unloaded.reason}`,
        );
      }
      const stillLoadedClean = this.#buffers
        .getSnapshot()
        .buffers.some(
          (buffer) =>
            buffer.loaded &&
            !buffer.modified &&
            buffer.absolutePath !== null &&
            workspaceTopologyKey(buffer.absolutePath) ===
              workspaceTopologyKey(path),
        );
      if (stillLoadedClean) {
        throw new Error(
          `The Editor still reports clean path ${path} after its safe unload completed.`,
        );
      }
    }
  }

  async abandonStaleAuthority(
    entries: readonly WorkspaceEditorStaleAuthorityEntry[],
  ): Promise<void> {
    if (this.#stopRequested || this.#stopped) {
      throw new Error("Editor workspace synchronization is stopping.");
    }
    if (entries.length === 0) {
      throw new Error("No stale Editor revisions were selected for recovery.");
    }
    if (
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null ||
      this.#workspaceWriteAuthorizationPromise !== null ||
      this.#proposalOperationActive
    ) {
      throw new Error(
        "Another authoritative Editor operation must finish before stale revisions can be abandoned.",
      );
    }
    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#heartbeatPromise !== null) await this.#heartbeatPromise;
    if (this.#syncPromise !== null) await this.#syncPromise;
    this.#publishAuthority({
      status: "blocked",
      reason:
        "Confirming the reviewed disk state and abandoning the selected orphaned Editor revisions…",
      staleAuthority: entries,
    });
    await this.#synchronize(true, entries);
    const remainingPaths = new Set(
      this.#staleAuthority.map((entry) => entry.path),
    );
    if (entries.some((entry) => remainingPaths.has(entry.path))) {
      throw new Error(
        "The selected orphaned Editor revisions are still protected. Review the current recovery evidence before trying again.",
      );
    }
  }

  async refreshStaleAuthority(): Promise<void> {
    if (this.#stopRequested || this.#stopped) {
      throw new Error("Editor workspace synchronization is stopping.");
    }
    if (this.#staleAuthority.length === 0) return;
    if (
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null ||
      this.#workspaceWriteAuthorizationPromise !== null ||
      this.#proposalOperationActive
    ) {
      throw new Error(
        "Another authoritative Editor operation must finish before stale disk evidence can be refreshed.",
      );
    }
    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#heartbeatPromise !== null) await this.#heartbeatPromise;
    if (this.#syncPromise !== null) await this.#syncPromise;
    const operation = this.#performStaleAuthorityRefresh();
    this.#syncPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#syncPromise === operation) this.#syncPromise = null;
      if (this.#syncQueued && !this.#stopped && !this.#stopRequested) {
        this.#syncQueued = false;
        this.#scheduleSync(0);
      }
    }
  }

  async #performStaleAuthorityRefresh(): Promise<void> {
    this.#publishAuthority({
      status: "blocked",
      reason:
        "Refreshing the current disk evidence for orphaned Editor revisions…",
      staleAuthority: this.#staleAuthority,
    });
    let lease = this.#lease;
    try {
      if (lease === null) {
        const acquired = await this.#client.acquireWorkspaceEditor({
          workspaceRoot: this.#workspaceRoot,
          editorInstanceId: this.#editorInstanceId,
        });
        this.#acceptAcquiredLease(acquired);
        lease = this.#lease;
      }
      if (lease === null) {
        throw new Error("The authoritative Editor lease is unavailable.");
      }
      const result = await this.#client.refreshWorkspaceEditorStaleAuthority({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      });
      if (
        result.refreshed !== true ||
        !isValidStaleAuthorityList(result.staleAuthority)
      ) {
        throw new Error(
          "The daemon returned malformed stale Editor recovery evidence.",
        );
      }
      if (
        this.#lease?.leaseToken !== lease.leaseToken ||
        this.#lease.epoch !== lease.epoch
      ) {
        throw new Error(
          "The authoritative Editor lease changed while disk evidence was refreshed.",
        );
      }
      this.#staleAuthority = result.staleAuthority;
      this.#lastErrorMessage = null;
      if (this.#staleAuthority.length > 0) {
        this.#initialSynchronizationComplete = false;
        this.#publishAuthority({
          status: "blocked",
          reason: staleAuthorityBlockReason(this.#staleAuthority),
          staleAuthority: this.#staleAuthority,
        });
        return;
      }
      this.#initialSynchronizationComplete = false;
      this.#lastObservedManifest = null;
      this.#lastSyncedManifest = null;
      this.#publishAuthority({ status: "syncing" });
      this.#syncQueued = true;
    } catch (cause) {
      if (this.#lease?.leaseToken === lease?.leaseToken) {
        this.#lease = null;
      }
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({
        status: "blocked",
        reason: errorMessage(cause),
        staleAuthority: this.#staleAuthority,
      });
      this.#report(cause);
      throw cause;
    }
  }

  async inspectWorkspaceMutationProposal(
    proposalId: string,
  ): Promise<WorkspaceEditorProposalResult> {
    // Durable proposal discovery runs inside #performSync's change poll. That
    // poll happens only after the exact buffer sync has been acknowledged, so
    // it may inspect with the current lease directly. Entering the ordinary
    // proposal-operation path here would await #syncPromise — the same sync
    // that is awaiting this callback — and deadlock forever.
    if (this.#workspaceChangeCallbackProposalId === proposalId) {
      const request = this.#client.getWorkspaceEditorProposal;
      if (request === undefined) {
        throw new Error("The daemon session cannot inspect editor proposals.");
      }
      return request(this.#proposalParams(proposalId));
    }
    return this.#runProposalOperation(async () => {
      const request = this.#client.getWorkspaceEditorProposal;
      if (request === undefined) {
        throw new Error("The daemon session cannot inspect editor proposals.");
      }
      return request(this.#proposalParams(proposalId));
    });
  }

  async inspectWorkspaceMutationProposalStatus(
    proposalId: string,
  ): Promise<WorkspaceEditorProposalStatusResult> {
    const inspect = this.#client.getWorkspaceEditorProposalStatus;
    if (inspect === undefined) {
      throw new Error(
        "The daemon session cannot inspect durable editor proposal status.",
      );
    }
    // Proposal discovery is awaited by the change poll itself. Match the
    // source-bearing inspection path above and use the current acknowledged
    // lease directly to avoid awaiting the same in-flight synchronization.
    if (this.#workspaceChangeCallbackProposalId === proposalId) {
      return inspect(this.#proposalParams(proposalId));
    }
    return this.#runProposalOperation(() =>
      inspect(this.#proposalParams(proposalId)),
    );
  }

  async acceptWorkspaceMutationProposal(input: {
    readonly proposal: WorkspaceEditorProposalResult;
    readonly editorProposalId: string;
    readonly acceptEditor: () => Promise<BufferEditorProposalResolution>;
  }): Promise<BufferEditorProposalResolution> {
    if (this.#pendingProposalRejection !== null) {
      return proposalResolutionError(
        input.editorProposalId,
        this.#pendingProposalRejection.proposal.proposalId ===
          input.proposal.proposalId
          ? "This proposal is already rejected in Editor. Accept is no longer safe; retry reject to finish daemon acknowledgement."
          : "Another proposal is already rejected locally and must be acknowledged before this proposal can be reviewed.",
        false,
        "reject",
      );
    }
    try {
      return await this.#runProposalOperation(async () => {
        if (this.#pendingProposalRejection !== null) {
          return proposalResolutionError(
            input.editorProposalId,
            this.#pendingProposalRejection.proposal.proposalId ===
              input.proposal.proposalId
              ? "This proposal is already rejected in Editor. Accept is no longer safe; retry reject to finish daemon acknowledgement."
              : "Another proposal is already rejected locally and must be acknowledged before this proposal can be reviewed.",
            false,
            "reject",
          );
        }
        const pending = this.#pendingProposalAcceptance;
        if (pending !== null) {
          if (
            pending.proposal.proposalId !== input.proposal.proposalId ||
            pending.editorProposalId !== input.editorProposalId
          ) {
            return proposalResolutionError(
              input.editorProposalId,
              "Another proposal is already accepted locally and must be acknowledged before this proposal can be reviewed.",
              false,
              "accept",
            );
          }
          return this.#acknowledgePendingProposalAcceptance();
        }
        if (this.#client.applyWorkspaceEditorProposal === undefined) {
          return proposalResolutionError(
            input.editorProposalId,
            "The daemon session cannot acknowledge editor proposals.",
          );
        }
        const accepted = await input.acceptEditor();
        if (!accepted.ok) return accepted;
        if (
          !isValidAcceptedEditorProposalResolution(
            accepted,
            input.editorProposalId,
            input.proposal.baseChangedtick,
            input.proposal.acceptedChangedtick,
          )
        ) {
          return proposalResolutionError(
            input.editorProposalId,
            "The editor returned an invalid accepted proposal revision.",
            false,
          );
        }
        this.#pendingProposalAcceptance = {
          proposal: input.proposal,
          editorProposalId: input.editorProposalId,
          accepted: {
            ok: true,
            action: "accepted",
            proposalId: accepted.proposalId,
            changedtick: accepted.changedtick,
          },
        };
        return this.#acknowledgePendingProposalAcceptance();
      });
    } catch (cause) {
      if (
        this.#pendingProposalAcceptance?.proposal.proposalId ===
        input.proposal.proposalId
      ) {
        return proposalResolutionError(
          input.editorProposalId,
          acknowledgementFailureMessage(cause),
          false,
          "accept",
        );
      }
      throw cause;
    }
  }

  async rejectWorkspaceMutationProposal(input: {
    readonly proposal: WorkspaceEditorProposalResult;
    readonly editorProposalId: string;
    readonly rejectEditor: () => Promise<BufferEditorProposalResolution>;
  }): Promise<BufferEditorProposalResolution> {
    if (this.#pendingProposalAcceptance !== null) {
      return proposalResolutionError(
        input.editorProposalId,
        this.#pendingProposalAcceptance.proposal.proposalId ===
          input.proposal.proposalId
          ? "This proposal is already accepted in Editor. Reject is no longer safe; retry accept to finish daemon acknowledgement."
          : "Another proposal is already accepted locally and must be acknowledged before this proposal can be reviewed.",
        false,
        "accept",
      );
    }
    try {
      return await this.#runProposalOperation(async () => {
        if (this.#pendingProposalAcceptance !== null) {
          return proposalResolutionError(
            input.editorProposalId,
            this.#pendingProposalAcceptance.proposal.proposalId ===
              input.proposal.proposalId
              ? "This proposal is already accepted in Editor. Reject is no longer safe; retry accept to finish daemon acknowledgement."
              : "Another proposal is already accepted locally and must be acknowledged before this proposal can be reviewed.",
            false,
            "accept",
          );
        }
        const pending = this.#pendingProposalRejection;
        if (pending !== null) {
          if (
            pending.proposal.proposalId !== input.proposal.proposalId ||
            pending.editorProposalId !== input.editorProposalId
          ) {
            return proposalResolutionError(
              input.editorProposalId,
              "Another proposal is already rejected locally and must be acknowledged before this proposal can be reviewed.",
              false,
              "reject",
            );
          }
          return this.#acknowledgePendingProposalRejection();
        }
        if (this.#client.discardWorkspaceEditorProposal === undefined) {
          return proposalResolutionError(
            input.editorProposalId,
            "The daemon session cannot discard editor proposals.",
          );
        }
        const rejected = await input.rejectEditor();
        if (!rejected.ok) return rejected;
        if (
          !isValidRejectedEditorProposalResolution(
            rejected,
            input.editorProposalId,
          )
        ) {
          return proposalResolutionError(
            input.editorProposalId,
            "The editor returned an invalid rejected proposal result.",
            false,
          );
        }
        this.#pendingProposalRejection = {
          proposal: input.proposal,
          editorProposalId: input.editorProposalId,
          rejected: {
            ok: true,
            action: "rejected",
            proposalId: rejected.proposalId,
          },
        };
        return this.#acknowledgePendingProposalRejection();
      });
    } catch (cause) {
      if (
        this.#pendingProposalRejection?.proposal.proposalId ===
        input.proposal.proposalId
      ) {
        return proposalResolutionError(
          input.editorProposalId,
          rejectionAcknowledgementFailureMessage(cause),
          false,
          "reject",
        );
      }
      throw cause;
    }
  }

  async discardWorkspaceMutationProposal(
    proposalId: string,
    expectedPath: string,
  ): Promise<void> {
    if (
      this.#pendingProposalAcceptance?.proposal.proposalId === proposalId ||
      this.#pendingProposalRejection?.proposal.proposalId === proposalId
    ) {
      throw new Error(
        "The proposal already has a local review outcome awaiting daemon acknowledgement.",
      );
    }
    await this.#runProposalOperation(async () => {
      const discard = this.#client.discardWorkspaceEditorProposal;
      if (discard === undefined) {
        throw new Error("The daemon session cannot discard editor proposals.");
      }
      const result = await discard(this.#proposalParams(proposalId));
      if (
        result.discarded !== true ||
        result.proposalId !== proposalId ||
        result.path !== expectedPath
      ) {
        throw new Error(
          "The daemon returned a malformed editor proposal discard acknowledgement.",
        );
      }
    });
  }

  async #finalizeTopologyMutation(
    tokenId: string,
    action: "complete" | "release",
    status: "applied" | "unknown_outcome",
  ): Promise<void> {
    if (this.#topologyFinalizePromise !== null) {
      await this.#topologyFinalizePromise;
      return;
    }
    if (this.#topologyOperation?.tokenId !== tokenId) {
      throw new Error(
        "The Editor project-path reservation is missing or already finalized.",
      );
    }
    const operation = (async () => {
      if (this.#heartbeatPromise !== null) {
        await this.#heartbeatPromise;
      }
      const lease = this.#lease;
      if (lease === null) {
        throw new Error(
          "The authoritative Editor lease was lost while the project-path operation was active. Restart AgenC to reconcile safely.",
        );
      }
      const captures = await this.#buffers.captureWorkspaceBuffers();
      const prepared = captures.map(workspaceBufferSync);
      const capturedSnapshotManifest = workspaceBufferManifestSignature(
        this.#buffers.getSnapshot(),
      );
      const manifest = synchronizedBufferManifestSignature(prepared);
      const sequence = this.#sequence + 1;
      const base = {
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        tokenId,
        sequence,
        buffers: prepared,
      };
      const result =
        action === "complete"
          ? await this.#client.completeWorkspaceEditorTopology!({
              ...base,
              status,
            })
          : await this.#client.releaseWorkspaceEditorTopology!(base);
      if (
        result.tokenId !== tokenId ||
        (action === "complete" &&
          (!("completed" in result) ||
            result.completed !== true ||
            result.status !== status)) ||
        (action === "release" &&
          (!("released" in result) || result.released !== true)) ||
        result.sync.accepted !== true ||
        !Number.isSafeInteger(result.sync.sequence) ||
        result.sync.sequence !== sequence
      ) {
        throw new Error(
          "The daemon returned a malformed Editor project-path finalization.",
        );
      }
      this.#sequence = result.sync.sequence;
      this.#lastSyncedManifest = manifest;
      this.#lease = {
        ...lease,
        sequence: result.sync.sequence,
        expiresAt: result.sync.expiresAt,
      };
      this.#initialSynchronizationComplete = true;
      this.#topologyOperation = null;
      this.#pollWorkspaceChangesInBackground();
      this.#lastErrorMessage = null;
      const currentManifest = workspaceBufferManifestSignature(
        this.#buffers.getSnapshot(),
      );
      if (currentManifest === capturedSnapshotManifest) {
        this.#syncQueued = false;
        this.#lastObservedManifest = currentManifest;
        this.#publishAuthority({ status: "ready" });
      } else {
        this.#lastObservedManifest = null;
        this.#publishAuthority({ status: "syncing" });
        this.#observe();
      }
    })();
    this.#topologyFinalizePromise = operation;
    try {
      await operation;
    } catch (cause) {
      this.#publishAuthority({
        status: "blocked",
        reason: errorMessage(cause),
      });
      this.#report(cause);
      throw cause;
    } finally {
      if (this.#topologyFinalizePromise === operation) {
        this.#topologyFinalizePromise = null;
      }
    }
  }

  #observe(): void {
    if (this.#stopRequested || this.#stopped) return;
    const snapshot = this.#buffers.getSnapshot();
    const liveNeovim = bufferSnapshotRequiresWorkspaceEditorAuthority(snapshot);
    if (
      (this.#topologyOperationStarting || this.#topologyOperation !== null) &&
      !liveNeovim
    ) {
      this.#publishAuthority({
        status: "blocked",
        reason:
          "Embedded Neovim closed during a project rename or delete. Restart AgenC to reconcile the durable workspace fence.",
      });
      return;
    }
    if (!liveNeovim) {
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({ status: "not_required" });
      this.#lastObservedManifest = null;
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      if (this.#lease !== null) void this.#releaseLease();
      return;
    }
    if (snapshot.providerStatus !== "ready") {
      // A transient provider reload can preserve the exact buffer manifest.
      // Invalidate the observation anyway so the next ready snapshot is
      // recaptured and can restore authority instead of remaining stuck in
      // `securing` behind an unchanged-manifest early return.
      this.#lastObservedManifest = null;
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      this.#publishAuthority({ status: "securing" });
      return;
    }
    if (
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null
    ) {
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      if (this.#authorityState.status !== "blocked") {
        this.#publishRecoveredTopologyBlock(
          "An interrupted Editor rename or delete left a durable path fence. Resolve its disk outcome explicitly before Editor can resynchronize.",
        );
      }
      return;
    }
    if (this.#topologyOperationStarting || this.#topologyOperation !== null) {
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      if (this.#authorityState.status !== "blocked") {
        this.#publishAuthority({ status: "syncing" });
      }
      return;
    }
    if (this.#hasPendingProposalAcknowledgement()) {
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      return;
    }
    const manifest = workspaceBufferManifestSignature(snapshot);
    if (manifest === this.#lastObservedManifest) return;
    this.#lastObservedManifest = manifest;
    this.#publishAuthority({
      status:
        this.#lease !== null && this.#initialSynchronizationComplete
          ? "syncing"
          : "securing",
    });
    // The first loaded-buffer publication is the authorization boundary:
    // do not leave a newly opened Neovim writable for the ordinary debounce
    // window before the daemon knows which paths it owns.
    this.#scheduleSync(
      this.#initialSynchronizationComplete ? this.#syncDebounceMs : 0,
    );
  }

  #scheduleSync(delayMs = this.#syncDebounceMs): void {
    if (
      this.#stopped ||
      this.#stopRequested ||
      this.#hasPendingProposalAcknowledgement() ||
      this.#recoveredTopologyMutations.length > 0 ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null
    ) {
      return;
    }
    if (this.#syncTimer !== null) clearTimeout(this.#syncTimer);
    this.#syncTimer = setTimeout(
      () => {
        this.#syncTimer = null;
        void this.#synchronize();
      },
      Math.max(0, delayMs),
    );
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#stopRequested || this.#retryTimer !== null)
      return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#observe();
      if (
        this.#buffers.getSnapshot().provider.kind === "neovim" &&
        this.#buffers.getSnapshot().providerStatus === "ready"
      ) {
        this.#scheduleSync(0);
      }
    }, this.#retryMs);
  }

  async #authorizeWorkspaceWrite(
    request: BufferWorkspaceWriteRequest,
  ): Promise<BufferWorkspaceWriteDecision> {
    if (this.#stopRequested || this.#stopped) {
      return {
        allowed: false,
        reason: "Editor workspace synchronization is stopping.",
      };
    }
    if (
      this.#workspaceWriteAuthorizationPromise !== null ||
      this.#syncPromise !== null ||
      this.#proposalOperationActive ||
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null
    ) {
      return {
        allowed: false,
        reason:
          "Another authoritative workspace operation is still settling. Retry :write.",
      };
    }
    const operation = this.#performWorkspaceWriteAuthorization(request);
    this.#workspaceWriteAuthorizationPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#workspaceWriteAuthorizationPromise === operation) {
        this.#workspaceWriteAuthorizationPromise = null;
      }
      this.#lastObservedManifest = null;
      if (!this.#stopRequested && !this.#stopped) {
        // Run after the inbound RPC response releases Neovim's BufWritePre.
        // The follow-up capture records the clean BufWritePost state, or the
        // still-dirty state if the filesystem write itself failed.
        this.#scheduleSync(0);
      }
    }
  }

  async #performWorkspaceWriteAuthorization(
    request: BufferWorkspaceWriteRequest,
  ): Promise<BufferWorkspaceWriteDecision> {
    try {
      this.#publishAuthority({ status: "syncing" });
      if (this.#heartbeatPromise !== null) await this.#heartbeatPromise;
      if (this.#lease === null) {
        const lease = await this.#client.acquireWorkspaceEditor({
          workspaceRoot: this.#workspaceRoot,
          editorInstanceId: this.#editorInstanceId,
        });
        this.#acceptAcquiredLease(lease);
      }
      const lease = this.#lease;
      if (lease === null) {
        throw new Error("The authoritative Editor lease is unavailable.");
      }
      let targetMatched = false;
      const captures = request.buffers.map((buffer) => {
        const isTarget =
          buffer.path === request.target.sourcePath &&
          buffer.bufferHandle === request.target.bufferHandle &&
          buffer.changedtick === request.target.changedtick &&
          buffer.endOfLine === request.target.endOfLine;
        if (isTarget) targetMatched = true;
        // Treat even an unchanged :write as editor-authoritative until the
        // post-write clean sync. This closes the interval between daemon
        // acknowledgement and the actual filesystem effect to new Agent
        // mutation admissions.
        return isTarget && !buffer.dirty ? { ...buffer, dirty: true } : buffer;
      });
      if (!targetMatched) {
        throw new Error(
          "The write target does not match the exact captured workspace manifest.",
        );
      }
      if (
        request.target.kind !== "buffer" ||
        request.target.path !== request.target.sourcePath
      ) {
        throw new Error(
          "The requested native write cannot be represented as one exact workspace buffer revision.",
        );
      }
      const prepared = captures.map(workspaceBufferSync);
      const sequence = this.#sequence + 1;
      const result = await this.#client.syncWorkspaceEditor({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence,
        buffers: prepared,
      });
      if (
        result.accepted !== true ||
        !Number.isSafeInteger(result.sequence) ||
        result.sequence !== sequence
      ) {
        throw new Error(
          `The daemon returned malformed editor sync sequence ${String(result.sequence)}; expected ${sequence}.`,
        );
      }
      this.#sequence = result.sequence;
      this.#lastSyncedManifest = synchronizedBufferManifestSignature(prepared);
      this.#lease = {
        ...lease,
        sequence: result.sequence,
        expiresAt: result.expiresAt,
      };
      this.#initialSynchronizationComplete = true;
      this.#lastErrorMessage = null;
      // Agent submissions stay fenced until the post-write state is observed
      // and acknowledged. The inbound reply only authorizes this one write.
      this.#publishAuthority({ status: "syncing" });
      return { allowed: true };
    } catch (cause) {
      const reason = errorMessage(cause);
      this.#report(cause);
      this.#lease = null;
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({ status: "blocked", reason });
      this.#scheduleRetry();
      return { allowed: false, reason };
    }
  }

  async #synchronize(
    force = false,
    abandonStaleAuthority?: readonly WorkspaceEditorStaleAuthorityEntry[],
  ): Promise<void> {
    if ((this.#stopped || this.#stopRequested) && !force) return;
    if (this.#hasPendingProposalAcknowledgement() && !force) return;
    if (this.#workspaceWriteAuthorizationPromise !== null && !force) {
      this.#syncQueued = true;
      return;
    }
    if (
      !force &&
      (this.#topologyOperationStarting || this.#topologyOperation !== null)
    ) {
      this.#syncQueued = true;
      return;
    }
    if (this.#proposalOperationActive && !force) {
      this.#syncQueued = true;
      return;
    }
    if (this.#syncPromise !== null) {
      this.#syncQueued = true;
      await this.#syncPromise;
      return;
    }
    const operation = this.#performSync(force, abandonStaleAuthority);
    this.#syncPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#syncPromise === operation) this.#syncPromise = null;
      if (this.#syncQueued && !this.#stopped && !this.#stopRequested) {
        this.#syncQueued = false;
        this.#scheduleSync(0);
      }
    }
  }

  async #performSync(
    force: boolean,
    abandonStaleAuthority?: readonly WorkspaceEditorStaleAuthorityEntry[],
  ): Promise<void> {
    try {
      if (this.#lease === null) {
        this.#publishAuthority({ status: "securing" });
        // A stopped synchronizer may still perform its one forced shutdown
        // capture. Ordinary background retries remain disabled after stop, but
        // teardown must reacquire if a preceding ambiguous RPC failure dropped
        // the local lease before the latest dirty revision was synchronized.
        if ((this.#stopped || this.#stopRequested) && !force) return;
        const lease = await this.#client.acquireWorkspaceEditor({
          workspaceRoot: this.#workspaceRoot,
          editorInstanceId: this.#editorInstanceId,
        });
        this.#acceptAcquiredLease(lease);
      }
      const lease = this.#lease;
      if (lease === null) return;
      if (await this.#discoverRecoveredTopologyMutations()) {
        this.#lastObservedManifest = workspaceBufferManifestSignature(
          this.#buffers.getSnapshot(),
        );
        return;
      }
      const captures = await this.#buffers.captureWorkspaceBuffers();
      const prepared = captures.map(workspaceBufferSync);
      const capturedSnapshotManifest = workspaceBufferManifestSignature(
        this.#buffers.getSnapshot(),
      );
      const manifest = synchronizedBufferManifestSignature(prepared);
      if (!force && manifest === this.#lastSyncedManifest) {
        if (this.#staleAuthority.length > 0) {
          this.#initialSynchronizationComplete = false;
          this.#publishAuthority({
            status: "blocked",
            reason: staleAuthorityBlockReason(this.#staleAuthority),
            staleAuthority: this.#staleAuthority,
          });
        } else {
          this.#initialSynchronizationComplete = true;
          this.#publishAuthority({ status: "ready" });
        }
        return;
      }
      const effectiveAbandonStaleAuthority =
        reconcileStaleAuthorityConfirmation(
          abandonStaleAuthority,
          this.#staleAuthority,
        );
      const sequence = this.#sequence + 1;
      const result = await this.#client.syncWorkspaceEditor({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        sequence,
        buffers: prepared,
        ...(effectiveAbandonStaleAuthority !== undefined
          ? { abandonStaleAuthority: effectiveAbandonStaleAuthority }
          : {}),
      });
      const returnedStaleAuthority =
        result.staleAuthority ?? this.#staleAuthority;
      if (
        result.accepted !== true ||
        !Number.isSafeInteger(result.sequence) ||
        result.sequence !== sequence ||
        !isValidStaleAuthorityList(returnedStaleAuthority)
      ) {
        throw new Error(
          `The daemon returned malformed editor sync sequence ${String(result.sequence)}; expected ${sequence}.`,
        );
      }
      this.#sequence = result.sequence;
      this.#lastSyncedManifest = manifest;
      this.#staleAuthority = returnedStaleAuthority;
      this.#lease = {
        ...lease,
        sequence: result.sequence,
        expiresAt: result.expiresAt,
      };
      this.#pollWorkspaceChangesInBackground();
      this.#lastErrorMessage = null;
      if (this.#staleAuthority.length > 0) {
        this.#initialSynchronizationComplete = false;
        this.#publishAuthority({
          status: "blocked",
          reason: staleAuthorityBlockReason(this.#staleAuthority),
          staleAuthority: this.#staleAuthority,
        });
        return;
      }
      this.#initialSynchronizationComplete = true;
      const currentManifest = workspaceBufferManifestSignature(
        this.#buffers.getSnapshot(),
      );
      if (currentManifest === capturedSnapshotManifest && !this.#syncQueued) {
        this.#publishAuthority({ status: "ready" });
      } else {
        this.#publishAuthority({ status: "syncing" });
        this.#lastObservedManifest = null;
        this.#observe();
      }
    } catch (cause) {
      if (cause instanceof BufferWorkspaceCaptureUnstableError) {
        // Ordinary insert-mode input can advance changedtick faster than the
        // multi-RPC background snapshot can settle. Keep the existing lease
        // and its daemon-side fence: native writes still pass through the
        // synchronous BufWritePre authority gate, while another background
        // capture can retry without turning normal keystrokes into read-only
        // input. A pre-existing stale-authority quarantine remains hard.
        if (this.#staleAuthority.length > 0) {
          this.#initialSynchronizationComplete = false;
          this.#publishAuthority({
            status: "blocked",
            reason: staleAuthorityBlockReason(this.#staleAuthority),
            staleAuthority: this.#staleAuthority,
          });
        } else {
          // Acquisition already established the daemon-side workspace fence,
          // and Neovim's native write gate stays installed while capture
          // retries. Keep provider input live even when the first snapshot is
          // unstable so no part of a command or insert is silently discarded.
          this.#publishAuthority({ status: "syncing" });
        }
        this.#scheduleRetry();
        if (force) throw cause;
        return;
      }
      this.#report(cause);
      this.#lease = null;
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({
        status: "blocked",
        reason: errorMessage(cause),
        ...(this.#staleAuthority.length > 0
          ? { staleAuthority: this.#staleAuthority }
          : {}),
      });
      this.#scheduleRetry();
      // Background synchronization remains retryable and reports through the
      // UI. A forced shutdown synchronization is the authorization boundary
      // for destructive provider cleanup, so its failure must remain visible
      // to the ordered teardown transaction.
      if (force) throw cause;
    }
  }

  #acceptAcquiredLease(lease: WorkspaceEditorLeaseResult): void {
    assertValidLeaseSequence(lease.sequence);
    if (
      lease.staleAuthority !== undefined &&
      !isValidStaleAuthorityList(lease.staleAuthority)
    ) {
      throw new Error(
        "The daemon returned malformed stale Editor recovery evidence.",
      );
    }
    const sameLease =
      this.#knownLeaseIdentity?.epoch === lease.epoch &&
      this.#knownLeaseIdentity.leaseToken === lease.leaseToken;
    if (sameLease && lease.sequence < this.#sequence) {
      throw new Error(
        `The daemon editor lease sequence moved backward from ${this.#sequence} to ${lease.sequence} for the current lease.`,
      );
    }
    // Acquire is the recovery handshake after any ambiguous RPC failure. Its
    // accepted sequence is authoritative for this token/epoch, so the next
    // sync resumes at server + 1 instead of replaying an already-applied
    // sequence whose response was lost.
    this.#sequence = lease.sequence;
    this.#lastSyncedManifest = null;
    this.#knownLeaseIdentity = {
      epoch: lease.epoch,
      leaseToken: lease.leaseToken,
    };
    if (lease.staleAuthority !== undefined) {
      this.#staleAuthority = lease.staleAuthority;
    }
    this.#lease = lease;
  }

  async #discoverRecoveredTopologyMutations(): Promise<boolean> {
    const request = this.#client.listRecoveredWorkspaceEditorTopologies;
    const lease = this.#lease;
    if (request === undefined || lease === null) return false;
    const result = await request({
      workspaceRoot: this.#workspaceRoot,
      editorInstanceId: this.#editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
    });
    if (!Array.isArray(result.mutations)) {
      throw new Error(
        "The daemon returned a malformed recovered project-path fence list.",
      );
    }
    const tokenIds = new Set<string>();
    for (const mutation of result.mutations) {
      if (
        typeof mutation?.tokenId !== "string" ||
        mutation.tokenId.length === 0 ||
        tokenIds.has(mutation.tokenId) ||
        typeof mutation.workspaceRoot !== "string" ||
        workspaceTopologyKey(mutation.workspaceRoot) !==
          workspaceTopologyKey(this.#workspaceRoot) ||
        !Array.isArray(mutation.targets) ||
        mutation.targets.length === 0 ||
        mutation.targets.some(
          (target) =>
            typeof target?.path !== "string" ||
            target.path.length === 0 ||
            !recoveredTopologyTargetWithinWorkspace(
              this.#workspaceRoot,
              target.path,
            ) ||
            (target.includeDescendants !== undefined &&
              typeof target.includeDescendants !== "boolean"),
        ) ||
        typeof mutation.source !== "string" ||
        !Number.isFinite(mutation.createdAt)
      ) {
        throw new Error(
          "The daemon returned a malformed recovered project-path fence list.",
        );
      }
      tokenIds.add(mutation.tokenId);
    }
    this.#recoveredTopologyMutations = result.mutations;
    if (result.mutations.length === 0) return false;
    this.#initialSynchronizationComplete = false;
    this.#publishRecoveredTopologyBlock(
      result.mutations.length === 1
        ? "An interrupted Editor rename or delete left a durable path fence. Review its paths, then explicitly mark the disk outcome unknown to audit and resynchronize."
        : `${result.mutations.length} interrupted Editor renames or deletes left durable path fences. Resolve each disk outcome explicitly before Editor can resynchronize.`,
    );
    return true;
  }

  #publishRecoveredTopologyBlock(reason: string): void {
    this.#publishAuthority({
      status: "blocked",
      reason,
      recoveredTopologyMutations: this.#recoveredTopologyMutations,
    });
  }

  async #heartbeat(): Promise<void> {
    if (
      this.#stopped ||
      this.#lease === null ||
      this.#proposalOperationActive ||
      this.#syncPromise !== null ||
      this.#workspaceWriteAuthorizationPromise !== null ||
      this.#topologyFinalizePromise !== null ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#heartbeatPromise !== null
    ) {
      return;
    }
    const lease = this.#lease;
    const operation = this.#client
      .heartbeatWorkspaceEditor({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
      })
      .then(async (renewed) => {
        if (
          this.#lease?.leaseToken === lease.leaseToken &&
          this.#lease.epoch === lease.epoch
        ) {
          this.#lease = renewed;
          if (!this.#stopRequested) {
            this.#pollWorkspaceChangesInBackground();
          }
          this.#lastErrorMessage = null;
        }
      })
      .catch((cause) => {
        if (this.#lease?.leaseToken === lease.leaseToken) {
          this.#lease = null;
        }
        this.#initialSynchronizationComplete = false;
        this.#publishAuthority({
          status: "blocked",
          reason: errorMessage(cause),
          ...(this.#staleAuthority.length > 0
            ? { staleAuthority: this.#staleAuthority }
            : {}),
        });
        this.#report(cause);
        this.#scheduleRetry();
      });
    this.#heartbeatPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#heartbeatPromise === operation) {
        this.#heartbeatPromise = null;
      }
    }
  }

  async #releaseLease(propagateFailure = false): Promise<void> {
    if (this.#syncPromise !== null) await this.#syncPromise.catch(() => {});
    if (this.#workspaceWriteAuthorizationPromise !== null) {
      await this.#workspaceWriteAuthorizationPromise;
    }
    if (this.#proposalOperationPromise !== null) {
      await this.#proposalOperationPromise.catch(() => {});
    }
    if (this.#heartbeatPromise !== null) {
      await this.#heartbeatPromise.catch(() => {});
    }
    const lease = this.#lease;
    if (lease === null) return;
    this.#lease = null;
    try {
      await this.#client.releaseWorkspaceEditor({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        // Never silently discard dirty authority. A closed/crashed editor
        // leaves unresolved dirty paths quarantined until it reconnects.
        abandonDirty: false,
      });
      this.#lastSyncedManifest = null;
      this.#knownLeaseIdentity = null;
      this.#staleAuthority = [];
      this.#initialSynchronizationComplete = false;
      this.#lastErrorMessage = null;
    } catch (cause) {
      this.#report(cause);
      if (propagateFailure) throw cause;
    }
  }

  async #prepareStop(): Promise<void> {
    if (
      this.#recoveredTopologyMutations.length > 0 ||
      this.#recoveredTopologyResolvePromise !== null ||
      this.#topologyOperationStarting ||
      this.#topologyOperation !== null ||
      this.#topologyFinalizePromise !== null
    ) {
      throw new Error(
        "Cannot tear down Editor while a project rename or delete has an unresolved durable workspace fence.",
      );
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#syncTimer !== null) clearTimeout(this.#syncTimer);
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#syncTimer = null;
    this.#retryTimer = null;
    if (this.#syncPromise !== null) await this.#syncPromise.catch(() => {});
    if (this.#hasPendingProposalAcknowledgement()) {
      try {
        if (this.#lease === null) {
          const lease = await this.#client.acquireWorkspaceEditor({
            workspaceRoot: this.#workspaceRoot,
            editorInstanceId: this.#editorInstanceId,
          });
          this.#acceptAcquiredLease(lease);
        }
        const acknowledged =
          this.#pendingProposalAcceptance !== null
            ? await this.#acknowledgePendingProposalAcceptance()
            : await this.#acknowledgePendingProposalRejection();
        if (!acknowledged.ok) {
          throw new Error(acknowledged.reason);
        }
      } catch (cause) {
        this.#report(cause);
        throw cause;
      }
    }
    if (
      this.#requiresFinalSynchronization() &&
      !this.#hasPendingProposalAcknowledgement()
    ) {
      await this.#synchronize(true);
    }
  }

  async #finishStop(): Promise<void> {
    if (this.#heartbeatPromise !== null) {
      await this.#heartbeatPromise.catch(() => {});
    }
    if (this.#lease === null && this.#knownLeaseIdentity !== null) {
      // A previous release response may have been lost after the daemon
      // committed it. Reacquire resolves that ambiguity: it returns the still
      // active lease, or creates a fresh lease that can be released cleanly.
      const lease = await this.#client.acquireWorkspaceEditor({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
      });
      this.#acceptAcquiredLease(lease);
    }
    if (this.#lease !== null) await this.#releaseLease(true);
    // Terminal stopped state is an acknowledgement, not an intention. Keep
    // the handler, interval, and synchronizer registration retryable until the
    // daemon has accepted release.
    this.#stopped = true;
    this.#buffers.setWorkspaceWriteAuthorityHandler?.(null);
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    if (
      topologySynchronizers.get(workspaceTopologyKey(this.#workspaceRoot)) ===
      this
    ) {
      topologySynchronizers.delete(workspaceTopologyKey(this.#workspaceRoot));
    }
  }

  #report(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (error.message === this.#lastErrorMessage) return;
    this.#lastErrorMessage = error.message;
    this.#onError?.(error);
  }

  #publishAuthority(state: WorkspaceEditorAuthorityState): void {
    if (
      this.#authorityState.status === state.status &&
      (state.status !== "blocked" ||
        (this.#authorityState.status === "blocked" &&
          this.#authorityState.reason === state.reason &&
          recoveredTopologySignature(
            this.#authorityState.recoveredTopologyMutations,
          ) === recoveredTopologySignature(state.recoveredTopologyMutations) &&
          staleAuthoritySignature(this.#authorityState.staleAuthority) ===
            staleAuthoritySignature(state.staleAuthority)))
    ) {
      return;
    }
    this.#authorityState = state;
    this.#onAuthorityChange?.(state);
  }

  async #pollWorkspaceChanges(): Promise<void> {
    const request = this.#client.listWorkspaceEditorChanges;
    const lease = this.#lease;
    if (request === undefined || lease === null) return;
    let result = await request({
      workspaceRoot: this.#workspaceRoot,
      editorInstanceId: this.#editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      afterSequence: this.#changeSequence,
    });
    if (result.sequence < this.#changeSequence) {
      // A daemon restart can restore an older durable sequence than this
      // long-lived TUI last observed. Reset the cursor and fetch the surviving
      // queue rather than silently skipping its first changes.
      this.#changeSequence = 0;
      result = await request({
        workspaceRoot: this.#workspaceRoot,
        editorInstanceId: this.#editorInstanceId,
        leaseToken: lease.leaseToken,
        epoch: lease.epoch,
        afterSequence: 0,
      });
    }
    for (const change of result.changes) {
      this.#workspaceChangeCallbackProposalId =
        change.status === "proposed" ? (change.proposalId ?? null) : null;
      try {
        if (change.kind === "topology") {
          await this.#reconcileTopologyInvalidation(change);
        }
        await this.#onWorkspaceChange?.(change);
      } finally {
        this.#workspaceChangeCallbackProposalId = null;
      }
    }
    this.#changeSequence = result.sequence;
  }

  async #reconcileTopologyInvalidation(
    change: WorkspaceEditorChangeResult,
  ): Promise<void> {
    if (
      change.kind !== "topology" ||
      typeof change.topologyTokenId !== "string" ||
      typeof change.includeDescendants !== "boolean" ||
      (change.status !== "applied" && change.status !== "unknown_outcome") ||
      !recoveredTopologyTargetWithinWorkspace(this.#workspaceRoot, change.path)
    ) {
      throw new Error(
        "The daemon returned a malformed project-path invalidation.",
      );
    }
    const beginProviderMutation = this.#buffers.beginProjectPathMutation;
    const endProviderMutation = this.#buffers.endProjectPathMutation;
    if (
      beginProviderMutation === undefined ||
      endProviderMutation === undefined ||
      !beginProviderMutation.call(this.#buffers)
    ) {
      throw new Error(
        "The active Editor provider cannot freeze project paths while applying a durable path invalidation.",
      );
    }
    try {
      const target: WorkspaceEditorTopologyTarget = {
        path: change.path,
        includeDescendants: change.includeDescendants,
      };
      const dirty = this.#buffers
        .getSnapshot()
        .buffers.find(
          (buffer) =>
            buffer.loaded &&
            buffer.modified &&
            buffer.bufferType === "" &&
            buffer.absolutePath !== null &&
            recoveredTopologyTargetContainsPath(target, buffer.absolutePath),
        );
      if (dirty !== undefined) {
        throw new Error(
          `Editor buffer ${dirty.absolutePath} has unsaved changes under a completed project-path operation. Save or discard it before acknowledging the disk invalidation.`,
        );
      }
      await this.#unloadRecoveredTopologyCleanTargets({
        tokenId: change.topologyTokenId,
        workspaceRoot: this.#workspaceRoot,
        targets: [target],
        source: change.source,
        createdAt: 0,
      });
      const racedDirty = this.#buffers
        .getSnapshot()
        .buffers.find(
          (buffer) =>
            buffer.loaded &&
            buffer.modified &&
            buffer.bufferType === "" &&
            buffer.absolutePath !== null &&
            recoveredTopologyTargetContainsPath(target, buffer.absolutePath),
        );
      if (racedDirty !== undefined) {
        throw new Error(
          `Editor buffer ${racedDirty.absolutePath} became dirty while applying a completed project-path operation. Save or discard it before acknowledging the disk invalidation.`,
        );
      }
      this.#lastObservedManifest = null;
      this.#lastSyncedManifest = null;
      this.#initialSynchronizationComplete = false;
      await this.#synchronize(true);
    } finally {
      endProviderMutation.call(this.#buffers);
    }
  }

  #pollWorkspaceChangesInBackground(): void {
    if (
      this.#workspaceChangePollPromise !== null ||
      this.#stopRequested ||
      this.#stopped
    )
      return;
    const operation = this.#pollWorkspaceChanges()
      .catch((cause) => {
        if (!this.#stopped && !this.#stopRequested) {
          this.#report(cause);
        }
      })
      .finally(() => {
        if (this.#workspaceChangePollPromise === operation) {
          this.#workspaceChangePollPromise = null;
        }
      });
    this.#workspaceChangePollPromise = operation;
  }

  #proposalParams(proposalId: string): WorkspaceEditorProposalParams {
    const lease = this.#lease;
    if (lease === null) {
      throw new Error("The authoritative editor lease is unavailable.");
    }
    return {
      workspaceRoot: this.#workspaceRoot,
      editorInstanceId: this.#editorInstanceId,
      leaseToken: lease.leaseToken,
      epoch: lease.epoch,
      proposalId,
    };
  }

  #hasPendingProposalAcknowledgement(): boolean {
    return (
      this.#pendingProposalAcceptance !== null ||
      this.#pendingProposalRejection !== null
    );
  }

  #requiresFinalSynchronization(): boolean {
    if (this.#lease !== null || this.#knownLeaseIdentity !== null) return true;
    const snapshot = this.#buffers.getSnapshot();
    return (
      bufferSnapshotRequiresWorkspaceEditorAuthority(snapshot) &&
      (snapshot.dirty || snapshot.buffers.length > 0)
    );
  }

  async #acknowledgePendingProposalAcceptance(): Promise<BufferEditorProposalResolution> {
    const pending = this.#pendingProposalAcceptance;
    if (pending === null) {
      throw new Error(
        "No accepted editor proposal is awaiting acknowledgement.",
      );
    }
    const apply = this.#client.applyWorkspaceEditorProposal;
    if (apply === undefined) {
      return proposalResolutionError(
        pending.editorProposalId,
        "The edit is already applied in Editor, but this daemon session cannot acknowledge it. Retry after reconnecting.",
        false,
        "accept",
      );
    }
    // The provider accepted proposal.afterText and returned the authoritative
    // resulting tick. A later capture can already contain an autocmd, plugin,
    // or user edit; acknowledgement must remain bound to the exact accepted
    // pair instead of becoming permanently unretryable.
    const acceptedContent = pending.proposal.afterText;
    const acceptedChangedtick = pending.accepted.changedtick;
    const contentSha256 = sha256(acceptedContent);
    try {
      const result = await apply({
        ...this.#proposalParams(pending.proposal.proposalId),
        changedtick: acceptedChangedtick,
        contentSha256,
        content: acceptedContent,
      });
      if (
        result.applied !== true ||
        result.proposalId !== pending.proposal.proposalId ||
        result.path !== pending.proposal.path ||
        result.changedtick !== acceptedChangedtick ||
        result.contentSha256 !== contentSha256
      ) {
        throw new Error(
          "The daemon returned a malformed editor proposal acknowledgement.",
        );
      }
      this.#pendingProposalAcceptance = null;
      return pending.accepted;
    } catch (cause) {
      // A response can be lost after the daemon commits. Drop only the lease,
      // not the accepted pair: the next user retry reacquires without
      // synchronizing and repeats the same idempotent acknowledgement.
      this.#lease = null;
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({
        status: "blocked",
        reason: acknowledgementFailureMessage(cause),
      });
      return proposalResolutionError(
        pending.editorProposalId,
        acknowledgementFailureMessage(cause),
        false,
        "accept",
      );
    }
  }

  async #acknowledgePendingProposalRejection(): Promise<BufferEditorProposalResolution> {
    const pending = this.#pendingProposalRejection;
    if (pending === null) {
      throw new Error(
        "No rejected editor proposal is awaiting acknowledgement.",
      );
    }
    const discard = this.#client.discardWorkspaceEditorProposal;
    if (discard === undefined) {
      return proposalResolutionError(
        pending.editorProposalId,
        "The proposal is already rejected in Editor, but this daemon session cannot acknowledge the discard. Retry after reconnecting.",
        false,
        "reject",
      );
    }
    try {
      const result = await discard(
        this.#proposalParams(pending.proposal.proposalId),
      );
      if (
        result.discarded !== true ||
        result.proposalId !== pending.proposal.proposalId ||
        result.path !== pending.proposal.path
      ) {
        throw new Error(
          "The daemon returned a malformed editor proposal discard acknowledgement.",
        );
      }
      this.#pendingProposalRejection = null;
      return pending.rejected;
    } catch (cause) {
      this.#lease = null;
      this.#initialSynchronizationComplete = false;
      this.#publishAuthority({
        status: "blocked",
        reason: rejectionAcknowledgementFailureMessage(cause),
      });
      return proposalResolutionError(
        pending.editorProposalId,
        rejectionAcknowledgementFailureMessage(cause),
        false,
        "reject",
      );
    }
  }

  async #runProposalOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#stopRequested || this.#stopped) {
      throw new Error("The authoritative editor lease is closed.");
    }
    if (this.#proposalOperationPromise !== null) {
      await this.#proposalOperationPromise.catch(() => {});
    }
    const running = (async () => {
      this.#proposalOperationActive = true;
      if (this.#syncTimer !== null) {
        clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
      }
      if (this.#syncPromise !== null) await this.#syncPromise;
      if (this.#workspaceWriteAuthorizationPromise !== null) {
        await this.#workspaceWriteAuthorizationPromise;
      }
      if (this.#lease === null) {
        if (this.#hasPendingProposalAcknowledgement()) {
          const lease = await this.#client.acquireWorkspaceEditor({
            workspaceRoot: this.#workspaceRoot,
            editorInstanceId: this.#editorInstanceId,
          });
          this.#acceptAcquiredLease(lease);
        } else {
          await this.#synchronize(true);
        }
      }
      return operation();
    })();
    this.#proposalOperationPromise = running;
    try {
      return await running;
    } finally {
      if (this.#proposalOperationPromise === running) {
        this.#proposalOperationPromise = null;
      }
      this.#proposalOperationActive = false;
      this.#lastObservedManifest = null;
      if (!this.#stopped && !this.#stopRequested) this.#observe();
    }
  }
}

/**
 * Builds one idempotent shutdown transaction for the editor workspace.
 * Final capture/sync happens before provider shutdown, while lease release
 * happens only after the provider proves a safe close or durable recovery.
 */
export function createOrderedWorkspaceEditorTeardown(
  synchronizer: Pick<
    WorkspaceEditorLeaseSynchronizer,
    "prepareStop" | "stop"
  > | null,
  cleanupProvider: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let completed: Promise<void> | null = null;
  let providerCleanupComplete = false;
  return () => {
    if (completed !== null) return completed;
    if (inFlight !== null) return inFlight;
    const attempt = (async () => {
      // Freeze observers and complete the final exact sync while both the
      // provider and daemon lease still own the same revision. Provider
      // cleanup must then prove a safe close or durable recovery before the
      // lease may be released. A preservation failure therefore retains
      // both the live editor and its daemon authority for retry/quarantine.
      await synchronizer?.prepareStop();
      if (!providerCleanupComplete) {
        await cleanupProvider();
        providerCleanupComplete = true;
      }
      await synchronizer?.stop();
    })();
    inFlight = attempt;
    void attempt.then(
      () => {
        if (inFlight === attempt) {
          completed = attempt;
          inFlight = null;
        }
      },
      () => {
        if (inFlight === attempt) inFlight = null;
      },
    );
    return attempt;
  };
}

/**
 * Finish an App-effect teardown without leaving a rejected promise for React's
 * synchronous disposal callback. Successful teardown can be unregistered.
 * Failed teardown stays registered with the process-level barrier so the
 * awaitable shutdown owner reports it instead of silently losing the failure.
 */
export async function settleWorkspaceEditorTeardown(
  teardown: () => Promise<void>,
  unregister: () => void,
): Promise<void> {
  try {
    await teardown();
  } catch {
    // React cannot await effect disposal. Keep the failed idempotent teardown
    // registered so the process/TUI shutdown barrier can observe and report
    // the same rejection instead of converting it into apparent success.
    return;
  }
  try {
    unregister();
  } catch {
    // React disposal must never manufacture an unhandled rejection.
  }
}

export function workspaceBufferSync(
  capture: BufferWorkspaceBufferCapture,
): WorkspaceEditorBufferSync {
  const contentSha256 = createHash("sha256")
    .update(capture.content, "utf8")
    .digest("hex");
  return {
    path: capture.path,
    bufferHandle: capture.bufferHandle,
    changedtick: capture.changedtick,
    contentSha256,
    contentBytes: Buffer.byteLength(capture.content, "utf8"),
    dirty: capture.dirty,
    ...(capture.dirty ? { content: capture.content } : {}),
  };
}

export function workspaceBufferManifestSignature(
  snapshot: Pick<BufferProviderSnapshot, "buffers" | "activeBufferHandle">,
): string {
  return JSON.stringify([
    snapshot.activeBufferHandle,
    snapshot.buffers
      .filter(
        (buffer) =>
          buffer.loaded &&
          buffer.bufferType === "" &&
          buffer.absolutePath !== null &&
          buffer.changedtick !== null,
      )
      .map((buffer) => [
        buffer.absolutePath,
        buffer.handle,
        buffer.changedtick,
        buffer.endOfLine,
        buffer.modified,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
}

function synchronizedBufferManifestSignature(
  buffers: readonly WorkspaceEditorBufferSync[],
): string {
  return JSON.stringify(
    buffers
      .map((buffer) => [
        buffer.path,
        buffer.bufferHandle,
        buffer.changedtick,
        buffer.contentSha256,
        buffer.dirty,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

function workspaceTopologyKey(workspaceRoot: string): string {
  return resolve(workspaceRoot).normalize("NFC");
}

function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const bounded = relative(parent, candidate);
  return (
    bounded === "" ||
    (bounded !== ".." &&
      !bounded.startsWith(`..${sep}`) &&
      !isAbsolute(bounded))
  );
}

function recoveredTopologyTargetWithinWorkspace(
  workspaceRoot: string,
  targetPath: string,
): boolean {
  if (!isAbsolute(targetPath)) return false;
  return isSameOrDescendantPath(
    workspaceTopologyKey(workspaceRoot),
    workspaceTopologyKey(targetPath),
  );
}

function recoveredTopologyTargetContainsPath(
  target: WorkspaceEditorTopologyTarget,
  path: string,
): boolean {
  const targetPath = workspaceTopologyKey(target.path);
  const candidatePath = workspaceTopologyKey(path);
  return (
    targetPath === candidatePath ||
    (target.includeDescendants === true &&
      isSameOrDescendantPath(targetPath, candidatePath))
  );
}

function recoveredTopologySignature(
  mutations: readonly WorkspaceEditorRecoveredTopologyMutation[] | undefined,
): string {
  return JSON.stringify(
    (mutations ?? []).map((mutation) => [
      mutation.tokenId,
      mutation.workspaceRoot,
      mutation.source,
      mutation.createdAt,
      mutation.targets.map((target) => [
        target.path,
        target.includeDescendants === true,
      ]),
    ]),
  );
}

function isValidStaleAuthorityList(
  value: unknown,
): value is readonly WorkspaceEditorStaleAuthorityEntry[] {
  if (!Array.isArray(value) || value.length > 512) return false;
  const paths = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      paths.has(entry.path) ||
      typeof entry.editorContentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.editorContentSha256) ||
      !Number.isSafeInteger(entry.editorContentBytes) ||
      entry.editorContentBytes < 0 ||
      !Number.isSafeInteger(entry.changedtick) ||
      entry.changedtick < 0 ||
      typeof entry.editorInstanceId !== "string" ||
      entry.editorInstanceId.length === 0 ||
      !Number.isSafeInteger(entry.epoch) ||
      entry.epoch < 1 ||
      (entry.editorState !== "dirty" && entry.editorState !== "clean") ||
      (entry.diskState !== "content" &&
        entry.diskState !== "missing" &&
        entry.diskState !== "unavailable")
    ) {
      return false;
    }
    if (entry.diskState === "content") {
      if (
        typeof entry.diskContentSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.diskContentSha256) ||
        !Number.isSafeInteger(entry.diskContentBytes) ||
        (entry.diskContentBytes as number) < 0
      ) {
        return false;
      }
    } else if (
      entry.diskContentSha256 !== undefined ||
      entry.diskContentBytes !== undefined
    ) {
      return false;
    }
    paths.add(entry.path);
  }
  return true;
}

function staleAuthoritySignature(
  entries: readonly WorkspaceEditorStaleAuthorityEntry[] | undefined,
): string {
  return JSON.stringify(
    (entries ?? []).map((entry) => [
      entry.path,
      entry.editorContentSha256,
      entry.editorContentBytes,
      entry.changedtick,
      entry.editorInstanceId,
      entry.epoch,
      entry.editorState,
      entry.diskState,
      entry.diskContentSha256 ?? null,
      entry.diskContentBytes ?? null,
    ]),
  );
}

function staleAuthorityEntriesEqual(
  left: WorkspaceEditorStaleAuthorityEntry,
  right: WorkspaceEditorStaleAuthorityEntry,
): boolean {
  return staleAuthoritySignature([left]) === staleAuthoritySignature([right]);
}

function reconcileStaleAuthorityConfirmation(
  requested: readonly WorkspaceEditorStaleAuthorityEntry[] | undefined,
  current: readonly WorkspaceEditorStaleAuthorityEntry[],
): readonly WorkspaceEditorStaleAuthorityEntry[] | undefined {
  if (requested === undefined) return undefined;
  if (!isValidStaleAuthorityList(requested) || requested.length === 0) {
    throw new Error("The stale Editor recovery confirmation is malformed.");
  }
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const matching = requested.filter((entry) => {
    const latest = currentByPath.get(entry.path);
    return latest !== undefined && staleAuthorityEntriesEqual(entry, latest);
  });
  if (matching.length === requested.length) return requested;
  if (requested.every((entry) => !currentByPath.has(entry.path))) {
    // The previous exact sync may have committed before its response was lost.
    // Reacquire is authoritative; continue with an ordinary sync instead of
    // turning an already-completed explicit choice into a permanent error.
    return undefined;
  }
  throw new Error(
    "The stale Editor or disk recovery evidence changed. Review it again before choosing Use Disk.",
  );
}

function staleAuthorityBlockReason(
  entries: readonly WorkspaceEditorStaleAuthorityEntry[],
): string {
  const count = entries.length;
  return (
    `${count} orphaned Editor revision${count === 1 ? "" : "s"} ` +
    `${count === 1 ? "still owns" : "still own"} workspace authority. ` +
    "Recover a matching Neovim swap if offered, or explicitly choose Use Disk after reviewing the affected paths."
  );
}

function assertValidLeaseSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < -1) {
    throw new Error(
      `The daemon returned malformed editor lease sequence ${String(sequence)}.`,
    );
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function proposalResolutionError(
  proposalId: string,
  reason: string,
  stale = false,
  acknowledgementAction?: "accept" | "reject",
): BufferEditorProposalResolution {
  return {
    ok: false,
    proposalId,
    reason,
    ...(stale ? { stale: true } : {}),
    ...(acknowledgementAction !== undefined
      ? {
          acknowledgementPending: true,
          acknowledgementAction,
        }
      : {}),
  };
}

function rejectionAcknowledgementFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    "The proposal is already rejected in Editor, but daemon discard " +
    `acknowledgement did not complete: ${detail}. Retry reject; accept is no longer safe.`
  );
}

function acknowledgementFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    "The edit is already applied in Editor, but daemon acknowledgement " +
    `did not complete: ${detail}. Retry accept; reject is no longer safe.`
  );
}
