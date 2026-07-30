import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import {
  openFileInBufferExternalEditor,
  type BufferExternalEditorLauncher,
} from "../../externalEditor.js";
import {
  BufferSaveConflictError,
  readBufferFileSnapshot,
  type BufferFileEncoding,
  type BufferFileSnapshot,
  type BufferLineEndings,
} from "../../fileSnapshot.js";
import {
  NeovimStartupCleanupError,
  startEmbeddedNeovim,
  type EmbeddedNeovimBuffer,
  type EmbeddedNeovimSession,
  type EmbeddedNeovimStartupContext,
  type EmbeddedNeovimStartupPreparation,
  type NeovimCloseResult,
  type NeovimExitInfo,
  type StartEmbeddedNeovimOptions,
} from "../../neovim/NeovimLifecycle.js";
import type { NeovimDiscoveryResult } from "../../neovim/NeovimDiscovery.js";
import { translateKeyToNeovimInput } from "../../neovim/NeovimInput.js";
import {
  createNeovimRenderSnapshot,
  type NeovimRenderSnapshot,
} from "../../neovim/NeovimGrid.js";
import {
  canonicalNeovimPath,
  canonicalNeovimPathIsAtOrWithin,
  canonicalNeovimPathKey,
} from "../../neovim/NeovimPath.js";
import {
  discardRecoverySwapFiles,
  recoveryCopyPath,
  type NeovimRecoveryPaths,
} from "../../neovim/NeovimRecovery.js";
import type { BufferMove } from "../../editing.js";
import type {
  BufferEditorProvider,
  BufferCaptureRequest,
  BufferCapturedContext,
  BufferCodePrediction,
  BufferCodePredictionContext,
  BufferCodePredictionFeedback,
  BufferEditorProposal,
  BufferEditorProposalResolution,
  BufferExternalChangeResolution,
  BufferIntegrationIntent,
  BufferIntegrationIntentListener,
  BufferRecoveryAction,
  BufferRecoveryResult,
  BufferProviderBuffer,
  BufferProviderCloseOptions,
  BufferProviderCleanupOptions,
  BufferProviderIdentity,
  BufferProviderInput,
  BufferProviderListener,
  BufferProviderOpenOptions,
  BufferProviderPathMutationResult,
  BufferProviderResize,
  BufferProviderSaveOptions,
  BufferProviderSaveAllResult,
  BufferProviderShutdownOptions,
  BufferProviderSnapshot,
  BufferWorkspaceBufferCapture,
  BufferWorkspaceWriteAuthorityHandler,
  BufferWorkspaceWriteDecision,
  BufferWorkspaceWriteRequest,
} from "../types.js";
import {
  emptyProviderSnapshot,
  NEOVIM_BUFFER_CAPABILITIES,
  positionFromNeovimCursor,
} from "../types.js";

export type NeovimBufferProviderOptions = {
  readonly discovery: Extract<NeovimDiscoveryResult, { readonly usable: true }>;
  readonly openExternalEditor?: BufferExternalEditorLauncher;
  readonly readFileSnapshot?: (filePath: string) => Promise<BufferFileSnapshot>;
  readonly startSession?: (
    options: StartEmbeddedNeovimOptions,
  ) => Promise<EmbeddedNeovimSession>;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  /** One-release rollback switch for the legacy per-file process lifecycle. */
  readonly sessionMode?: "workspace" | "file";
  readonly workspaceRoot?: string;
  readonly agencHome?: string;
  readonly requireWorkspaceWriteAuthority?: boolean;
  readonly beforeOpenFile?: (
    context: EmbeddedNeovimStartupContext,
  ) => Promise<EmbeddedNeovimStartupPreparation | void>;
};

type NeovimProviderOwnership = {
  readonly generation: number;
  readonly session: EmbeddedNeovimSession;
};

type NeovimOperationOwnership = NeovimProviderOwnership & {
  readonly openGeneration: number;
};

type NeovimFileOwnership = {
  readonly generation: number;
  readonly openGeneration: number;
  readonly filePath: string | null;
  readonly absolutePath: string | null;
};

type NeovimWorkspaceCaptureCandidate = {
  readonly handle: number;
  readonly path: string;
  readonly changedtick: number;
  readonly endOfLine: boolean;
  readonly modified: boolean;
};

type NeovimPendingSessionStart = {
  readonly controller: AbortController;
  readonly promise: Promise<EmbeddedNeovimSession>;
  session: EmbeddedNeovimSession | null;
  disposalPromise: Promise<void> | null;
};

type NeovimSessionActionGate = {
  readonly generation: number;
  readonly promise: Promise<void>;
  readonly release: () => void;
  allowActions: boolean;
};

type StartNeovimSession = (
  options: StartEmbeddedNeovimOptions,
) => Promise<EmbeddedNeovimSession>;

const NEOVIM_EDITOR_SESSION_IDS = new WeakMap<EmbeddedNeovimSession, string>();

function identifyIntegrationIntent(
  intent: BufferIntegrationIntent,
  editorSessionId: string,
): BufferIntegrationIntent {
  return {
    ...intent,
    context: {
      ...intent.context,
      editorSessionId,
    },
  };
}

async function startIdentifiedNeovimSession(
  startSession: StartNeovimSession,
  options: StartEmbeddedNeovimOptions,
): Promise<EmbeddedNeovimSession> {
  const editorSessionId = randomUUID();
  const session = await startSession({
    ...options,
    onIntegrationIntent:
      options.onIntegrationIntent === undefined
        ? undefined
        : (intent) => {
            options.onIntegrationIntent?.(
              identifyIntegrationIntent(intent, editorSessionId),
            );
          },
  });
  NEOVIM_EDITOR_SESSION_IDS.set(session, editorSessionId);
  return session;
}

async function startUncommittedNeovimSession(
  startSession: StartNeovimSession,
  options: StartEmbeddedNeovimOptions,
): Promise<EmbeddedNeovimSession> {
  const editorSessionId = randomUUID();
  let phase: "starting" | "committed" | "abandoned" = "starting";
  let latestSnapshot:
    Parameters<StartEmbeddedNeovimOptions["onSnapshot"]>[0] | null = null;
  let latestDirty: boolean | undefined;
  let workspaceChanged = false;
  const integrationIntents: Parameters<
    NonNullable<StartEmbeddedNeovimOptions["onIntegrationIntent"]>
  >[0][] = [];
  const codePredictionFeedback: Parameters<
    NonNullable<StartEmbeddedNeovimOptions["onCodePredictionFeedback"]>
  >[0][] = [];
  const recoveries: Parameters<
    NonNullable<StartEmbeddedNeovimOptions["onRecoveryDetected"]>
  >[0][] = [];
  let startupError: Error | null = null;
  let fatalError: Error | null = null;
  let earlyExit: Parameters<StartEmbeddedNeovimOptions["onExit"]>[0] | null =
    null;

  const attemptOptions: StartEmbeddedNeovimOptions = {
    ...options,
    onSnapshot: (snapshot) => {
      if (phase === "committed") options.onSnapshot(snapshot);
      else if (phase === "starting") latestSnapshot = snapshot;
    },
    onDirtyChange: (dirty) => {
      if (phase === "committed") options.onDirtyChange?.(dirty);
      else if (phase === "starting") latestDirty = dirty;
    },
    onWorkspaceChange: () => {
      if (phase === "committed") options.onWorkspaceChange?.();
      else if (phase === "starting") workspaceChanged = true;
    },
    onIntegrationIntent: (intent) => {
      const identifiedIntent = identifyIntegrationIntent(
        intent,
        editorSessionId,
      );
      if (phase === "committed") {
        options.onIntegrationIntent?.(identifiedIntent);
      } else if (phase === "starting") {
        integrationIntents.push(identifiedIntent);
      }
    },
    onCodePredictionFeedback: (feedback) => {
      if (phase === "committed") {
        options.onCodePredictionFeedback?.(feedback);
      } else if (phase === "starting") {
        codePredictionFeedback.push(feedback);
      }
    },
    onRecoveryDetected: (recovery) => {
      if (phase === "committed") options.onRecoveryDetected?.(recovery);
      else if (phase === "starting") recoveries.push(recovery);
    },
    onError: (error) => {
      if (phase === "committed") options.onError(error);
      else if (phase === "starting") startupError = error;
    },
    onFatalError: (error) => {
      if (phase === "committed") options.onFatalError?.(error);
      else if (phase === "starting") fatalError = error;
    },
    onExit: (exit) => {
      if (phase === "committed") options.onExit(exit);
      else if (phase === "starting") {
        earlyExit = exit ?? { code: null, signal: null, stderrTail: "" };
      }
    },
  };

  let session: EmbeddedNeovimSession;
  try {
    session = await startSession(attemptOptions);
    NEOVIM_EDITOR_SESSION_IDS.set(session, editorSessionId);
  } catch (error) {
    phase = "abandoned";
    throw error;
  }

  if (earlyExit !== null || fatalError !== null) {
    phase = "abandoned";
    const failure =
      fatalError ?? startupExitFailure(earlyExit as NeovimExitInfo | null);
    try {
      await session.cleanup();
    } catch (cleanupFailure) {
      throw new NeovimStartupCleanupError(failure, cleanupFailure, () =>
        session.cleanup(),
      );
    }
    throw failure;
  }

  phase = "committed";
  if (latestSnapshot !== null) options.onSnapshot(latestSnapshot);
  if (latestDirty !== undefined) options.onDirtyChange?.(latestDirty);
  if (workspaceChanged) options.onWorkspaceChange?.();
  for (const intent of integrationIntents)
    options.onIntegrationIntent?.(intent);
  for (const feedback of codePredictionFeedback) {
    options.onCodePredictionFeedback?.(feedback);
  }
  for (const recovery of recoveries) options.onRecoveryDetected?.(recovery);
  if (startupError !== null) options.onError(startupError);
  return session;
}

export class NeovimBufferProvider implements BufferEditorProvider {
  readonly identity: BufferProviderIdentity;
  readonly #listeners = new Set<BufferProviderListener>();
  readonly #integrationIntentListeners =
    new Set<BufferIntegrationIntentListener>();
  readonly #codePredictionFeedbackListeners = new Set<
    (feedback: BufferCodePredictionFeedback) => void
  >();
  readonly #discovery: Extract<
    NeovimDiscoveryResult,
    { readonly usable: true }
  >;
  readonly #startupTimeoutMs: number | undefined;
  readonly #operationTimeoutMs: number | undefined;
  readonly #cleanupTimeoutMs: number | undefined;
  readonly #sessionMode: "workspace" | "file";
  readonly #workspaceRoot: string | undefined;
  readonly #agencHome: string | undefined;
  readonly #requireWorkspaceWriteAuthority: boolean;
  readonly #beforeOpenFile:
    | ((
        context: EmbeddedNeovimStartupContext,
      ) => Promise<EmbeddedNeovimStartupPreparation | void>)
    | undefined;
  readonly #openExternalEditor: BufferExternalEditorLauncher;
  readonly #readFileSnapshot: (filePath: string) => Promise<BufferFileSnapshot>;
  readonly #startSession: (
    options: StartEmbeddedNeovimOptions,
  ) => Promise<EmbeddedNeovimSession>;
  #session: EmbeddedNeovimSession | null = null;
  #snapshot: BufferProviderSnapshot;
  #terminal: NeovimRenderSnapshot = createNeovimRenderSnapshot(20, 80);
  #size: BufferProviderResize = { rows: 20, columns: 80 };
  #filePath: string | null = null;
  #absolutePath: string | null = null;
  #fileSnapshot: BufferFileSnapshot | null = null;
  #encoding: BufferFileEncoding | null = null;
  #lineEndings: BufferLineEndings | null = null;
  #dirty = false;
  #buffers: readonly BufferProviderBuffer[] = [];
  #activeBufferHandle: number | null = null;
  #fileSnapshots = new Map<string, BufferFileSnapshot>();
  #providerExit: BufferProviderSnapshot["providerExit"] = null;
  #recovery: BufferProviderSnapshot["recovery"] = null;
  #activeRecovery: {
    readonly swapFile: string;
    readonly filePath: string;
  } | null = null;
  #queuedRecoveries: Array<{
    readonly swapFile: string;
    readonly filePath: string;
  }> = [];
  #recoveryOperation: Promise<BufferRecoveryResult> | null = null;
  #exitExpected = false;
  #workspaceRefreshPromise: Promise<void> | null = null;
  #workspaceRefreshQueued = false;
  #statusMessage: string | null = null;
  #openGeneration = 0;
  #pendingTransitionGeneration: number | null = null;
  #ownershipGeneration = 0;
  #fileGeneration = 0;
  #pendingSessionStart: NeovimPendingSessionStart | null = null;
  #safeStartupFailure: string | null = null;
  #navigationPromise: Promise<void> | null = null;
  #sessionActionGate: NeovimSessionActionGate | null = null;
  #projectPathMutationLocked = false;
  #workspaceAuthorityRequired = false;
  #workspaceWriteAuthorityHandler: BufferWorkspaceWriteAuthorityHandler | null =
    null;
  #recoveryPreservationRequired = false;
  #unconfirmedRecoveryExit: Error | null = null;

  constructor(options: NeovimBufferProviderOptions) {
    this.#discovery = options.discovery;
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#operationTimeoutMs = options.operationTimeoutMs;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs;
    this.#sessionMode = options.sessionMode ?? "workspace";
    this.#workspaceRoot = options.workspaceRoot;
    this.#agencHome = options.agencHome;
    this.#requireWorkspaceWriteAuthority =
      options.requireWorkspaceWriteAuthority === true;
    this.#beforeOpenFile = options.beforeOpenFile;
    this.#openExternalEditor =
      options.openExternalEditor ?? openFileInBufferExternalEditor;
    this.#readFileSnapshot =
      options.readFileSnapshot ??
      ((filePath) =>
        readBufferFileSnapshot(filePath, {
          ...(this.#workspaceRoot !== undefined
            ? { basePath: this.#workspaceRoot }
            : {}),
        }));
    this.#startSession = options.startSession ?? startEmbeddedNeovim;
    this.identity = {
      kind: "neovim",
      label: `embedded Neovim ${options.discovery.version.raw}`,
      fallbackReason: null,
      capabilities: NEOVIM_BUFFER_CAPABILITIES,
    };
    this.#snapshot = emptyProviderSnapshot(this.identity);
  }

  subscribe(listener: BufferProviderListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): BufferProviderSnapshot {
    return this.#snapshot;
  }

  getVisibleLines(): readonly [] {
    return [];
  }

  /**
   * Returns a startup failure only when no Neovim session was committed and
   * the contained lifecycle confirmed cleanup for every attempted process.
   * The controller uses this narrow signal for auto-mode inline fallback.
   */
  safeStartupFailureReason(): string | null {
    if (this.#session !== null || this.#pendingSessionStart !== null)
      return null;
    return this.#safeStartupFailure;
  }

  async captureContext(
    request: BufferCaptureRequest,
  ): Promise<BufferCapturedContext | null> {
    const session = this.#session;
    if (!session) return null;
    const context = await session.captureContext(request);
    if (context === null || this.#session !== session) return null;
    const editorSessionId = NEOVIM_EDITOR_SESSION_IDS.get(session);
    return editorSessionId === undefined
      ? context
      : {
          ...context,
          editorSessionId,
        };
  }

  async captureWorkspaceBuffers(): Promise<
    readonly BufferWorkspaceBufferCapture[]
  > {
    const session = this.#session;
    if (!session) return [];
    const ownership = this.#captureOperationOwnership(session);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.#inspectSessionBuffers(session);
      if (!this.#ownsOperation(ownership)) return [];
      const candidates = this.#workspaceCaptureCandidates(before.buffers);
      const contents = await Promise.all(
        candidates.map((candidate) => session.readBufferText(candidate.handle)),
      );
      if (!this.#ownsOperation(ownership)) return [];
      const after = await this.#inspectSessionBuffers(session);
      if (!this.#ownsOperation(ownership)) return [];
      const stable = this.#workspaceCaptureCandidates(after.buffers);

      if (!sameWorkspaceCaptureManifest(candidates, stable)) continue;

      return candidates.map((candidate, index) => ({
        path: candidate.path,
        bufferHandle: candidate.handle,
        changedtick: candidate.changedtick,
        endOfLine: candidate.endOfLine,
        dirty: candidate.modified,
        content: contents[index]!,
      }));
    }

    throw new Error(
      "Neovim buffers changed during workspace synchronization; retry.",
    );
  }

  setWorkspaceWriteAuthorityHandler(
    handler: BufferWorkspaceWriteAuthorityHandler | null,
  ): void {
    this.#workspaceWriteAuthorityHandler = handler;
  }

  async reloadCleanPath(path: string): Promise<BufferExternalChangeResolution> {
    const session = this.#session;
    if (!session) {
      return {
        ok: false,
        path,
        reason: "Embedded Neovim is not running.",
      };
    }
    const ownership = this.#captureOperationOwnership(session);
    const result = await session.reloadCleanPath(path);
    if (!this.#ownsOperation(ownership)) {
      return {
        ok: false,
        path,
        reason: "The editor session changed during external reload.",
      };
    }
    await this.#refreshWorkspace(ownership);
    if (!this.#ownsOperation(ownership)) {
      return {
        ok: false,
        path,
        reason: "The editor session changed during external reload.",
      };
    }
    this.#emitSnapshot();
    return result.ok
      ? { ok: true, path, reloaded: result.reloaded }
      : {
          ok: false,
          path,
          reason: result.reason,
          ...(result.dirty === true ? { dirty: true } : {}),
        };
  }

  stageProposal(
    proposal: BufferEditorProposal,
  ): Promise<BufferEditorProposalResolution> {
    const proposalId = `${proposal.interaction_id}:${proposal.base_changedtick}`;
    if (this.#projectPathMutationLocked) {
      return Promise.resolve({
        ok: false,
        proposalId,
        reason:
          "Wait for the current project rename or delete before staging an Editor proposal.",
      });
    }
    if (!this.#session) {
      return Promise.resolve({
        ok: false,
        proposalId,
        reason: "Embedded Neovim is not running.",
      });
    }
    return this.#session.stageProposal({
      ...proposal,
      path:
        proposal.path.length === 0 || isAbsolute(proposal.path)
          ? proposal.path
          : resolve(this.#workspaceRoot ?? process.cwd(), proposal.path),
    });
  }

  acceptProposal(proposalId: string): Promise<BufferEditorProposalResolution> {
    if (this.#projectPathMutationLocked) {
      return Promise.resolve({
        ok: false,
        proposalId,
        reason:
          "Wait for the current project rename or delete before accepting an Editor proposal.",
      });
    }
    return (
      this.#session?.acceptProposal(proposalId) ??
      Promise.resolve({
        ok: false,
        proposalId,
        reason: "Embedded Neovim is not running.",
      })
    );
  }

  rejectProposal(proposalId: string): Promise<BufferEditorProposalResolution> {
    if (this.#projectPathMutationLocked) {
      return Promise.resolve({
        ok: false,
        proposalId,
        reason:
          "Wait for the current project rename or delete before rejecting an Editor proposal.",
      });
    }
    return (
      this.#session?.rejectProposal(proposalId) ??
      Promise.resolve({
        ok: false,
        proposalId,
        reason: "Embedded Neovim is not running.",
      })
    );
  }

  captureCodePredictionContext(): Promise<BufferCodePredictionContext | null> {
    return (
      this.#session?.captureCodePredictionContext() ?? Promise.resolve(null)
    );
  }

  stageCodePrediction(prediction: BufferCodePrediction): Promise<boolean> {
    return (
      this.#session?.stageCodePrediction(prediction) ?? Promise.resolve(false)
    );
  }

  clearCodePrediction(requestId?: string): Promise<boolean> {
    return (
      this.#session?.clearCodePrediction(requestId) ?? Promise.resolve(false)
    );
  }

  subscribeCodePredictionFeedback(
    listener: (feedback: BufferCodePredictionFeedback) => void,
  ): () => void {
    this.#codePredictionFeedbackListeners.add(listener);
    return () => {
      this.#codePredictionFeedbackListeners.delete(listener);
    };
  }

  subscribeIntegrationIntents(
    listener: BufferIntegrationIntentListener,
  ): () => void {
    this.#integrationIntentListeners.add(listener);
    return () => {
      this.#integrationIntentListeners.delete(listener);
    };
  }

  resolveRecovery(action: BufferRecoveryAction): Promise<BufferRecoveryResult> {
    if (this.#projectPathMutationLocked) {
      return Promise.resolve({
        ok: false,
        reason:
          "Wait for the current project rename or delete before resolving BUFFER recovery.",
      });
    }
    if (this.#recoveryOperation) {
      return Promise.resolve({
        ok: false,
        reason: "An embedded Neovim recovery action is already in progress.",
      });
    }
    const operation = this.#performRecovery(action);
    this.#recoveryOperation = operation;
    void operation.finally(() => {
      if (this.#recoveryOperation !== operation) return;
      this.#recoveryOperation = null;
      if (this.#activeRecovery && this.#recovery?.status === "working") {
        this.#recovery = {
          status: "pending",
          swapFiles: [this.#activeRecovery.swapFile],
          error: "Recovery was interrupted before Neovim confirmed completion.",
        };
        this.#statusMessage =
          "Recovery was interrupted before Neovim confirmed completion.";
        this.#emitSnapshot();
      }
    });
    return operation;
  }

  async #performRecovery(
    action: BufferRecoveryAction,
  ): Promise<BufferRecoveryResult> {
    const session = this.#session;
    const recovery = session?.recovery;
    const activeRecovery = this.#activeRecovery;
    if (!session || !recovery || !activeRecovery) {
      return { ok: false, reason: "No embedded Neovim recovery is pending." };
    }
    const ownership = this.#captureOperationOwnership(session);
    this.#recovery = {
      status: "working",
      swapFiles: [activeRecovery.swapFile],
    };
    this.#emitSnapshot();
    try {
      const paths = recovery as NeovimRecoveryPaths;
      const swapFile = activeRecovery.swapFile;
      await session.openFile(activeRecovery.filePath, 1, 0);
      if (!this.#ownsOperation(ownership)) {
        return {
          ok: false,
          reason: "The Neovim workspace changed before recovery.",
        };
      }
      let copyPath: string | undefined;
      let recoveredBufferHandle = 0;
      if (action !== "discard") {
        copyPath =
          action === "save-copy"
            ? recoveryCopyPath(paths, activeRecovery.filePath)
            : undefined;
        recoveredBufferHandle = await session.applyRecovery(
          action,
          swapFile,
          copyPath,
        );
      }
      if (!this.#ownsOperation(ownership)) {
        return {
          ok: false,
          reason: "The Neovim workspace changed during recovery.",
        };
      }
      const replacementSwap = await session.finishRecovery(
        recoveredBufferHandle,
        action === "recover" || action === "compare",
      );
      if (!replacementSwap) {
        throw new Error("Neovim did not confirm its post-recovery swap state.");
      }
      if (!this.#ownsOperation(ownership)) {
        return {
          ok: false,
          reason: "Neovim did not confirm recovery completion.",
        };
      }
      // Only remove the old durable swap after Neovim has either persisted a
      // replacement for recovered edits or confirmed the clean disk/copy path.
      if (replacementSwap !== swapFile) {
        await discardRecoverySwapFiles(paths, [swapFile]);
      }
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return {
          ok: false,
          reason: "The Neovim workspace changed after recovery.",
        };
      }
      await this.#refreshFileSnapshot(this.#captureFileOwnership());
      const completedRecovery: NonNullable<BufferProviderSnapshot["recovery"]> =
        {
          status:
            action === "recover"
              ? "recovered"
              : action === "compare"
                ? "comparing"
                : action === "save-copy"
                  ? "copy-saved"
                  : "recovered",
          swapFiles: [],
          ...(copyPath ? { copyPath } : {}),
        };
      this.#activeRecovery = null;
      const completionMessage =
        action === "save-copy"
          ? `Recovered contents saved to ${copyPath}.`
          : action === "discard"
            ? "Recovery swap discarded; disk contents restored."
            : action === "compare"
              ? "Recovered contents opened beside the on-disk file."
              : "Recovered contents restored as unsaved BUFFER changes.";
      const nextRecovery = this.#queuedRecoveries.shift() ?? null;
      if (nextRecovery) {
        this.#activeRecovery = nextRecovery;
        this.#recovery = {
          status: "pending",
          swapFiles: [nextRecovery.swapFile],
        };
        this.#statusMessage = `${completionMessage} Recovery is also required for ${nextRecovery.filePath}.`;
      } else {
        this.#recovery = completedRecovery;
        this.#statusMessage = completionMessage;
      }
      this.#emitSnapshot();
      return { ok: true, ...(copyPath ? { copyPath } : {}) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.#ownsOperation(ownership)) {
        this.#recovery = {
          status: "pending",
          swapFiles: [activeRecovery.swapFile],
          error: reason,
        };
        this.#statusMessage = `Recovery failed: ${reason}`;
        this.#emitSnapshot();
      }
      return { ok: false, reason };
    }
  }

  async open(options: BufferProviderOpenOptions): Promise<void> {
    if (this.#projectPathMutationLocked) {
      this.#setSnapshot(
        "conflict",
        "Wait for the current project rename or delete before navigating BUFFER.",
      );
      return;
    }
    if (this.#recoveryOperation) {
      this.#statusMessage =
        "Wait for the current recovery action before opening another file.";
      this.#emitSnapshot();
      return;
    }
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#pendingTransitionGeneration = generation;
    const sessionActionGate = this.#beginSessionActionGate(generation);
    let openSucceeded = false;
    try {
      if (this.#pendingSessionStart) {
        await this.#cancelPendingSessionStart().catch((error) => {
          throw cleanupError("before opening another file", error);
        });
      }
      if (generation !== this.#openGeneration) return;
      this.#workspaceAuthorityRequired = true;
      this.#setSnapshot("loading", null);
      const file = await this.#readFileSnapshot(options.filePath);
      if (generation !== this.#openGeneration) return;
      const normalizedFile = {
        ...file,
        absolutePath: normalizeNeovimBufferPath(
          file.absolutePath,
          this.#workspaceRoot,
        ),
      };
      if (
        this.#activeRecovery &&
        !sameNeovimFilePath(
          normalizedFile.absolutePath,
          normalizeNeovimBufferPath(
            this.#activeRecovery.filePath,
            this.#workspaceRoot,
          ),
        )
      ) {
        this.#setSnapshot(
          "conflict",
          `Resolve recovery for ${this.#activeRecovery.filePath} before opening another file.`,
          "disk",
        );
        return;
      }

      const existingSession = this.#session;
      if (existingSession && this.#sessionMode === "file") {
        const ownership = this.#captureOwnership(existingSession);
        this.#exitExpected = true;
        const closeResult = await existingSession.quit(false).catch((error) => {
          this.#exitExpected = false;
          throw cleanupError("before opening another file", error);
        });
        if (generation !== this.#openGeneration) return;
        if (!closeResult.closed) {
          this.#exitExpected = false;
          if (!this.#owns(ownership)) return;
          this.#setSnapshot(
            "conflict",
            "Unsaved edits. Save, discard, or cancel before opening another file.",
            "disk",
          );
          return;
        }
        this.#releaseSession(existingSession);
        this.#resetFileState();
      } else if (existingSession) {
        const ownership = this.#captureOperationOwnership(existingSession);
        const wasAlreadyLoaded = this.#buffers.some(
          (buffer) =>
            buffer.absolutePath !== null &&
            sameNeovimFilePath(
              buffer.absolutePath,
              normalizedFile.absolutePath,
            ),
        );
        const previousNavigation = this.#navigationPromise;
        const navigation = (async () => {
          await previousNavigation?.catch(() => undefined);
          const opened = await existingSession.openFile(
            normalizedFile.absolutePath,
            options.line ?? 1,
            options.column ?? 0,
          );
          if (!opened)
            throw new Error(
              "Embedded Neovim exited before the file could be opened.",
            );
        })();
        this.#navigationPromise = navigation;
        try {
          await navigation;
        } finally {
          if (this.#navigationPromise === navigation)
            this.#navigationPromise = null;
        }
        if (!this.#ownsOperation(ownership)) return;
        this.#setActiveFile(normalizedFile, wasAlreadyLoaded);
        await this.#refreshWorkspace(ownership);
        if (!this.#ownsOperation(ownership)) return;
        if (!wasAlreadyLoaded) {
          await this.#refreshFileSnapshot(this.#captureFileOwnership());
          if (!this.#ownsOperation(ownership)) return;
        }
        this.#setSnapshot("ready", null);
        openSucceeded = true;
        return;
      }

      this.#resetFileState();
      this.#terminal = createNeovimRenderSnapshot(
        this.#size.rows,
        this.#size.columns,
      );
      this.#setActiveFile(normalizedFile);
      let exited = false;
      let fatalSessionFailure = false;
      let committedOwnership: NeovimProviderOwnership | null = null;
      const isCurrentOpen = () =>
        !exited &&
        (committedOwnership
          ? this.#owns(committedOwnership)
          : generation === this.#openGeneration);
      const startupController = new AbortController();
      let startupFallbackMessage: string | null = null;
      const startupOptions: StartEmbeddedNeovimOptions = {
        executable: this.#discovery.executable,
        args: this.#discovery.args,
        filePath: normalizedFile.absolutePath,
        line: options.line ?? 1,
        column: options.column ?? 0,
        size: this.#size,
        workspaceRoot: this.#workspaceRoot,
        agencHome: this.#agencHome,
        beforeOpenFile: this.#beforeOpenFile,
        signal: startupController.signal,
        startupTimeoutMs: this.#startupTimeoutMs,
        operationTimeoutMs: this.#operationTimeoutMs,
        cleanupTimeoutMs: this.#cleanupTimeoutMs,
        onSnapshot: (terminal) => {
          if (!isCurrentOpen()) return;
          this.#terminal = terminal;
          if (generation === this.#openGeneration) {
            this.#setSnapshot("ready", null);
          } else {
            this.#emitSnapshot();
          }
        },
        onDirtyChange: (dirty) => {
          if (!isCurrentOpen()) return;
          this.#handleDirtyChange(dirty);
        },
        onWorkspaceChange: () => {
          if (!isCurrentOpen() || !committedOwnership) return;
          this.#scheduleWorkspaceRefresh(committedOwnership);
        },
        requireWorkspaceWriteAuthority: this.#requireWorkspaceWriteAuthority,
        onBeforeWorkspaceWrite: (request) => {
          if (!isCurrentOpen() || !committedOwnership) {
            return Promise.resolve({
              allowed: false,
              reason: "The embedded editor session is not committed yet.",
            });
          }
          return this.#authorizeWorkspaceWrite(request);
        },
        onIntegrationIntent: (intent) => {
          if (!isCurrentOpen()) return;
          this.#emitIntegrationIntent({
            ...intent,
            context: {
              ...intent.context,
              path: this.#workspaceDisplayPath(intent.context.path),
            },
          });
        },
        onCodePredictionFeedback: (feedback) => {
          if (!isCurrentOpen()) return;
          this.#emitCodePredictionFeedback(feedback);
        },
        onRecoveryDetected: (recovery) => {
          if (!isCurrentOpen()) return;
          this.#handleRecoveryDetected(recovery);
        },
        onError: (error) => {
          if (!isCurrentOpen()) return;
          this.#setSnapshot("error", error.message);
        },
        onFatalError: (error) => {
          fatalSessionFailure = true;
          if (!isCurrentOpen()) return;
          this.#setSnapshot("error", error.message);
        },
        onExit: (exit) => {
          if (!isCurrentOpen()) return;
          exited = true;
          const hadDirtyBuffers =
            this.#dirty || this.#buffers.some((buffer) => buffer.modified);
          const normalizedExit = exit ?? {
            code: null,
            signal: null,
            stderrTail: "",
          };
          const exitKind =
            this.#exitExpected ||
            (!fatalSessionFailure &&
              normalizedExit.code === 0 &&
              normalizedExit.signal === null)
              ? "intentional"
              : "crash";
          this.#providerExit = {
            kind: exitKind,
            ...normalizedExit,
          };
          const preservationProven =
            committedOwnership?.session.recoveryPreservationProven === true;
          const recoveryStillUnproven =
            !preservationProven &&
            (this.#recoveryPreservationRequired ||
              (exitKind === "crash" && hadDirtyBuffers));
          if (recoveryStillUnproven) {
            this.#unconfirmedRecoveryExit ??= new Error(
              "Embedded Neovim exited before exact dirty-buffer recovery preservation was confirmed.",
            );
          }
          this.#workspaceAuthorityRequired = recoveryStillUnproven;
          this.#exitExpected = false;
          if (committedOwnership)
            this.#releaseSession(committedOwnership.session);
          // Once the child is gone there is no live dirty authority left to
          // save or discard. Retain file/recovery/crash metadata for the
          // restart card, but never route an intentional :q! through a
          // stale dirty-buffer approval overlay.
          this.#dirty = false;
          this.#buffers = [];
          this.#activeBufferHandle = null;
          const detail =
            normalizedExit.stderrTail ||
            [
              normalizedExit.signal ? `signal ${normalizedExit.signal}` : null,
              normalizedExit.code !== null && normalizedExit.code !== 0
                ? `exit ${normalizedExit.code}`
                : null,
            ]
              .filter(Boolean)
              .join(", ");
          this.#setSnapshot(
            "closed",
            detail
              ? `Embedded Neovim exited (${detail}).`
              : "Embedded Neovim exited.",
          );
        },
      };
      const pendingStart: NeovimPendingSessionStart = {
        controller: startupController,
        promise: Promise.resolve().then(async () => {
          const fallback = this.#discovery.fallback;
          if (fallback === undefined) {
            return startIdentifiedNeovimSession(
              this.#startSession,
              startupOptions,
            );
          }
          let primaryError: unknown;
          try {
            return await startUncommittedNeovimSession(
              this.#startSession,
              startupOptions,
            );
          } catch (error) {
            primaryError = error;
          }
          if (
            primaryError instanceof NeovimStartupCleanupError ||
            startupController.signal.aborted
          ) {
            throw primaryError;
          }
          try {
            const session = await startUncommittedNeovimSession(
              this.#startSession,
              {
                ...startupOptions,
                args: fallback.args,
              },
            );
            startupFallbackMessage =
              "User Neovim init failed; BUFFER restarted with a clean init.";
            return session;
          } catch (fallbackError) {
            // Preserve retryable cleanup ownership. Wrapping this typed error
            // in AggregateError would make an unsafe process look like an
            // ordinary, fully-contained startup failure.
            if (fallbackError instanceof NeovimStartupCleanupError) {
              throw fallbackError;
            }
            throw new AggregateError(
              [primaryError, fallbackError],
              `User Neovim init failed: ${errorDetail(primaryError)}; ` +
                `clean-init fallback failed: ${errorDetail(fallbackError)}`,
            );
          }
        }),
        session: null,
        disposalPromise: null,
      };
      this.#pendingSessionStart = pendingStart;
      let session: EmbeddedNeovimSession;
      try {
        session = await pendingStart.promise;
        pendingStart.session = session;
      } catch (error) {
        if (
          !(error instanceof NeovimStartupCleanupError) &&
          generation === this.#openGeneration &&
          this.#pendingSessionStart === pendingStart
        ) {
          this.#pendingSessionStart = null;
          this.#safeStartupFailure = errorDetail(error);
        }
        throw error;
      }
      if (generation !== this.#openGeneration || exited) {
        await this.#disposePendingSessionStart(pendingStart).catch((error) => {
          throw cleanupError(
            exited
              ? "after exiting during startup"
              : "after startup was superseded",
            error,
          );
        });
        return;
      }
      if (this.#pendingSessionStart === pendingStart)
        this.#pendingSessionStart = null;
      this.#session = session;
      this.#safeStartupFailure = null;
      this.#ownershipGeneration += 1;
      this.#providerExit = null;
      this.#exitExpected = false;
      if (!session.recovery) {
        this.#recovery = null;
        this.#activeRecovery = null;
      }
      committedOwnership = this.#captureOwnership(session);
      const openingOwnership = this.#captureOperationOwnership(session);
      await this.#refreshWorkspace(openingOwnership);
      if (exited || !this.#ownsOperation(openingOwnership)) return;
      await this.#refreshFileSnapshot(this.#captureFileOwnership());
      if (exited || !this.#ownsOperation(openingOwnership)) return;
      this.#setSnapshot("ready", startupFallbackMessage);
      openSucceeded = true;
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      if (
        this.#session === null &&
        this.#pendingSessionStart === null &&
        !(error instanceof NeovimStartupCleanupError)
      ) {
        this.#workspaceAuthorityRequired = false;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#setSnapshot("error", message);
    } finally {
      sessionActionGate.allowActions = openSucceeded;
      sessionActionGate.release();
      if (this.#sessionActionGate === sessionActionGate) {
        this.#sessionActionGate = null;
      }
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
    }
  }

  async save(options: BufferProviderSaveOptions = {}): Promise<boolean> {
    if (this.#projectPathMutationLocked) {
      this.#setSnapshot(
        "conflict",
        "Wait for the current project rename or delete before saving BUFFER.",
      );
      return false;
    }
    if (options.hasInFlightAgent) {
      this.#setSnapshot(
        "conflict",
        "An agent appears to be editing this file. Wait or force save from Neovim when intentional.",
        "agent",
      );
      return false;
    }
    const session = this.#session;
    if (!session) return false;
    const ownership = this.#captureOperationOwnership(session);
    const previousSnapshot = this.#snapshot;
    const previousStatusMessage = this.#statusMessage;
    this.#setSnapshot("saving", null);
    try {
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) return false;
      const activeBufferHandle = this.#activeBufferHandle;
      if (activeBufferHandle === null) {
        this.#setSnapshot(
          "error",
          "Embedded Neovim has no active buffer to save.",
        );
        return false;
      }
      const fileSnapshot = this.#fileSnapshot;
      if (!fileSnapshot && options.force !== true) {
        this.#setSnapshot(
          "conflict",
          "Cannot safely write the active Neovim buffer because its disk baseline is unavailable.",
          "disk",
        );
        return false;
      }
      await this.#assertNoDiskConflict(options.force === true, fileSnapshot);
      if (!this.#ownsOperation(ownership)) return false;
      const stableSession = session as EmbeddedNeovimSession & {
        saveBuffer?: (handle: number, force?: boolean) => Promise<boolean>;
      };
      const saved =
        typeof stableSession.saveBuffer === "function"
          ? await stableSession.saveBuffer(
              activeBufferHandle,
              options.force === true,
            )
          : await session.save(options.force === true);
      if (!this.#ownsOperation(ownership)) return false;
      if (!saved) {
        this.#restoreActionableSnapshot(
          previousSnapshot,
          previousStatusMessage,
          "Embedded Neovim is closed; no file was saved.",
        );
        return false;
      }
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) return false;
      await this.#refreshFileSnapshot(this.#captureFileOwnership());
      this.#setSnapshot("ready", null);
      return true;
    } catch (error) {
      if (!this.#ownsOperation(ownership)) return false;
      if (error instanceof BufferSaveConflictError) {
        this.#setSnapshot("conflict", error.message, "disk");
        return false;
      }
      this.#setSnapshot(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async inspectDirtyBuffers(): Promise<readonly BufferProviderBuffer[]> {
    const session = this.#session;
    if (!session) return [];
    const ownership = this.#captureOperationOwnership(session);
    await this.#refreshWorkspace(ownership);
    if (!this.#ownsOperation(ownership)) return [];
    return this.#buffers.filter((buffer) => buffer.modified);
  }

  async selectBuffer(handle: number): Promise<boolean> {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (!session) return false;
    const ownership = this.#captureOperationOwnership(session);
    await this.#refreshWorkspace(ownership);
    if (!this.#ownsOperation(ownership)) return false;
    const buffer = this.#buffers.find(
      (candidate) =>
        candidate.handle === handle && candidate.listed && candidate.loaded,
    );
    if (!buffer) {
      this.#setSnapshot(
        "error",
        `Neovim buffer ${handle} is no longer available.`,
      );
      return false;
    }
    const stableSession = session as EmbeddedNeovimSession & {
      selectBuffer?: (bufferHandle: number) => Promise<boolean>;
    };
    if (typeof stableSession.selectBuffer !== "function") {
      return handle === this.#activeBufferHandle;
    }
    try {
      const selected = await stableSession.selectBuffer(handle);
      if (!selected || !this.#ownsOperation(ownership)) return false;
      await this.#refreshWorkspace(ownership);
      return (
        this.#ownsOperation(ownership) && this.#activeBufferHandle === handle
      );
    } catch (error) {
      if (this.#ownsOperation(ownership)) {
        this.#setSnapshot(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    }
  }

  async saveBuffer(
    handle: number,
    options: BufferProviderSaveOptions = {},
  ): Promise<boolean> {
    if (this.#projectPathMutationLocked) {
      this.#setSnapshot(
        "conflict",
        "Wait for the current project rename or delete before saving BUFFER.",
      );
      return false;
    }
    if (options.hasInFlightAgent) {
      this.#setSnapshot(
        "conflict",
        "An agent appears to be editing this file. Wait or force save from Neovim when intentional.",
        "agent",
      );
      return false;
    }
    const session = this.#session;
    if (!session) return false;
    const ownership = this.#captureOperationOwnership(session);
    await this.#refreshWorkspace(ownership);
    if (!this.#ownsOperation(ownership)) return false;
    const buffer = this.#buffers.find(
      (candidate) => candidate.handle === handle,
    );
    if (!buffer) {
      this.#setSnapshot(
        "error",
        `Neovim buffer ${handle} is no longer loaded.`,
      );
      return false;
    }
    try {
      const baseline = buffer.absolutePath
        ? (this.#fileSnapshots.get(
            neovimFileSnapshotKey(buffer.absolutePath),
          ) ?? null)
        : null;
      if (!baseline && options.force !== true) {
        this.#setSnapshot(
          "conflict",
          `Cannot safely write ${buffer.filePath ?? buffer.name}: its disk baseline is unavailable.`,
          "disk",
        );
        return false;
      }
      await this.#assertNoDiskConflict(options.force === true, baseline);
      if (!this.#ownsOperation(ownership)) return false;
      const stableSession = session as EmbeddedNeovimSession & {
        saveBuffer?: (handle: number, force?: boolean) => Promise<boolean>;
      };
      const saved =
        typeof stableSession.saveBuffer === "function"
          ? await stableSession.saveBuffer(handle, options.force === true)
          : handle === this.#activeBufferHandle
            ? await session.save(options.force === true)
            : false;
      if (!saved || !this.#ownsOperation(ownership)) return false;
      await this.#refreshWorkspace(ownership);
      if (buffer.absolutePath) {
        await this.#captureBaseline(
          buffer.absolutePath,
          buffer.handle,
          session,
        );
      }
      if (!this.#ownsOperation(ownership)) return false;
      this.#setSnapshot("ready", null);
      return true;
    } catch (error) {
      if (!this.#ownsOperation(ownership)) return false;
      if (error instanceof BufferSaveConflictError) {
        this.#setSnapshot("conflict", error.message, "disk");
      } else {
        this.#setSnapshot(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    }
  }

  async saveAll(
    options: BufferProviderSaveOptions = {},
  ): Promise<BufferProviderSaveAllResult> {
    if (this.#projectPathMutationLocked) {
      const reason =
        "Wait for the current project rename or delete before Save All.";
      this.#setSnapshot("conflict", reason);
      return {
        saved: false,
        reason,
        blockedBuffers: this.#buffers.filter((buffer) => buffer.modified),
      };
    }
    if (options.hasInFlightAgent) {
      const reason =
        "An agent appears to be editing this workspace. Wait before Save All.";
      this.#setSnapshot("conflict", reason, "agent");
      return {
        saved: false,
        reason,
        blockedBuffers: this.#buffers.filter((buffer) => buffer.modified),
      };
    }
    const session = this.#session;
    if (!session) {
      return { saved: true, buffers: [] };
    }
    const ownership = this.#captureOperationOwnership(session);
    this.#setSnapshot("saving", null);
    try {
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return {
          saved: false,
          reason: "The Neovim workspace changed before Save All completed.",
          blockedBuffers: [],
        };
      }
      // Freeze the exact Neovim identities that this transaction preflights.
      // The session must never re-inspect and silently widen the write set
      // after disk-conflict checks have completed.
      const frozenManifest = await this.#inspectSessionBuffers(session);
      if (!this.#ownsOperation(ownership)) {
        return {
          saved: false,
          reason: "The Neovim workspace changed before Save All completed.",
          blockedBuffers: [],
        };
      }
      const frozenDirtyBuffers = frozenManifest.buffers.filter(
        (buffer) => buffer.modified,
      );
      const dirtyBuffers = frozenDirtyBuffers.map((buffer) =>
        this.#providerBuffer(buffer),
      );
      const failClosed = (
        reason: string,
        blockedBuffers: readonly BufferProviderBuffer[] = dirtyBuffers,
      ): BufferProviderSaveAllResult => {
        this.#setSnapshot("conflict", reason, "disk");
        return { saved: false, reason, blockedBuffers };
      };
      const unstableBuffers = frozenDirtyBuffers
        .filter((buffer) => buffer.changedtick === null)
        .map((buffer) => this.#providerBuffer(buffer));
      if (unstableBuffers.length > 0) {
        return failClosed(
          "One or more modified Neovim buffers have no stable changedtick.",
          unstableBuffers,
        );
      }
      const unsaveable = dirtyBuffers.filter(
        (buffer) =>
          !buffer.saveable || (buffer.readOnly && options.force !== true),
      );
      if (unsaveable.length > 0) {
        return failClosed(
          "One or more modified Neovim buffers cannot be written.",
          unsaveable,
        );
      }
      for (const buffer of dirtyBuffers) {
        const baseline = buffer.absolutePath
          ? this.#fileSnapshots.get(neovimFileSnapshotKey(buffer.absolutePath))
          : undefined;
        if (!baseline && options.force !== true) {
          const reason = `Cannot safely write ${buffer.filePath ?? buffer.name}: its disk baseline is unavailable.`;
          this.#setSnapshot("conflict", reason, "disk");
          return { saved: false, reason, blockedBuffers: [buffer] };
        }
        await this.#assertNoDiskConflict(
          options.force === true,
          baseline ?? null,
        );
        if (!this.#ownsOperation(ownership)) {
          return {
            saved: false,
            reason: "The Neovim workspace changed before Save All completed.",
            blockedBuffers: dirtyBuffers,
          };
        }
      }

      const savedHandles = new Set<number>();
      for (const frozenBuffer of frozenDirtyBuffers) {
        const remaining = frozenDirtyBuffers.filter(
          (buffer) => !savedHandles.has(buffer.handle),
        );
        const liveManifest = await this.#inspectSessionBuffers(session);
        if (!this.#ownsOperation(ownership)) {
          return {
            saved: false,
            reason: "The Neovim workspace changed before Save All completed.",
            blockedBuffers: dirtyBuffers,
          };
        }
        const manifestChange = saveAllManifestChangeReason(
          remaining,
          liveManifest.buffers,
        );
        if (manifestChange !== null) {
          return failClosed(
            manifestChange,
            liveManifest.buffers
              .filter((buffer) => buffer.modified)
              .map((buffer) => this.#providerBuffer(buffer)),
          );
        }
        const liveBuffer = liveManifest.buffers.find(
          (buffer) => buffer.handle === frozenBuffer.handle,
        );
        if (
          !liveBuffer ||
          !liveBuffer.saveable ||
          (liveBuffer.readOnly && options.force !== true)
        ) {
          return failClosed(
            `Neovim buffer ${frozenBuffer.handle} can no longer be written.`,
            liveBuffer ? [this.#providerBuffer(liveBuffer)] : dirtyBuffers,
          );
        }
        const providerBuffer = this.#providerBuffer(frozenBuffer);
        const baseline = providerBuffer.absolutePath
          ? this.#fileSnapshots.get(
              neovimFileSnapshotKey(providerBuffer.absolutePath),
            )
          : undefined;
        await this.#assertNoDiskConflict(
          options.force === true,
          baseline ?? null,
        );
        if (!this.#ownsOperation(ownership)) {
          return {
            saved: false,
            reason: "The Neovim workspace changed before Save All completed.",
            blockedBuffers: dirtyBuffers,
          };
        }
        const saved = await session.saveBuffer(
          frozenBuffer.handle,
          options.force === true,
          frozenBuffer.changedtick ?? undefined,
        );
        if (!saved || !this.#ownsOperation(ownership)) {
          return failClosed(
            `Neovim buffer ${frozenBuffer.handle} closed before it could be written.`,
            [providerBuffer],
          );
        }
        savedHandles.add(frozenBuffer.handle);
      }

      const finalManifest = await this.#inspectSessionBuffers(session);
      const finalManifestChange = saveAllManifestChangeReason(
        [],
        finalManifest.buffers,
      );
      if (finalManifestChange !== null) {
        return failClosed(
          finalManifestChange,
          finalManifest.buffers
            .filter((buffer) => buffer.modified)
            .map((buffer) => this.#providerBuffer(buffer)),
        );
      }
      await Promise.all(
        dirtyBuffers.flatMap((buffer) =>
          buffer.absolutePath
            ? [
                this.#captureBaseline(
                  buffer.absolutePath,
                  buffer.handle,
                  session,
                ),
              ]
            : [],
        ),
      );
      if (!this.#ownsOperation(ownership)) {
        return {
          saved: false,
          reason: "The Neovim workspace changed before Save All completed.",
          blockedBuffers: [],
        };
      }
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return {
          saved: false,
          reason: "The Neovim workspace changed before Save All completed.",
          blockedBuffers: [],
        };
      }
      const remainingDirty = this.#buffers.filter((buffer) => buffer.modified);
      if (remainingDirty.length > 0) {
        return failClosed(
          "Neovim gained modified buffers before Save All completed.",
          remainingDirty,
        );
      }
      this.#setSnapshot("ready", null);
      return {
        saved: true,
        buffers: dirtyBuffers.map((buffer) => ({ ...buffer, modified: false })),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.#ownsOperation(ownership)) {
        this.#setSnapshot(
          error instanceof BufferSaveConflictError ? "conflict" : "error",
          reason,
          "disk",
        );
      }
      return {
        saved: false,
        reason,
        blockedBuffers: this.#buffers.filter((buffer) => buffer.modified),
      };
    }
  }

  async prepareDiscardAll(): Promise<string | null> {
    if (this.#projectPathMutationLocked) return null;
    const session = this.#session;
    if (!session) return discardManifestFingerprint([]);
    const ownership = this.#captureOperationOwnership(session);
    try {
      const manifest = await this.#inspectSessionBuffers(session);
      if (!this.#ownsOperation(ownership)) return null;
      const dirtyBuffers = manifest.buffers.filter((buffer) => buffer.modified);
      if (dirtyBuffers.some((buffer) => buffer.changedtick === null)) {
        this.#setSnapshot(
          "conflict",
          "Cannot confirm Discard All because a dirty buffer has no stable changedtick.",
          "disk",
        );
        return null;
      }
      return discardManifestFingerprint(dirtyBuffers);
    } catch (error) {
      if (this.#ownsOperation(ownership)) {
        this.#setSnapshot(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    }
  }

  async discardAll(confirmationToken?: string): Promise<boolean> {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (!session) {
      return confirmationToken === discardManifestFingerprint([]);
    }
    if (confirmationToken === undefined) return false;
    const ownership = this.#captureOperationOwnership(session);
    try {
      const manifest = await this.#inspectSessionBuffers(session);
      if (!this.#ownsOperation(ownership)) return false;
      const confirmedDirtyBuffers = manifest.buffers.filter(
        (buffer) => buffer.modified,
      );
      if (
        confirmedDirtyBuffers.some((buffer) => buffer.changedtick === null) ||
        discardManifestFingerprint(confirmedDirtyBuffers) !== confirmationToken
      ) {
        // Publish the exact manifest that invalidated confirmation. The UI
        // must not show a clean workspace while asking the user to review a
        // newly changed dirty-buffer set.
        this.#buffers = manifest.buffers.map((buffer) =>
          this.#providerBuffer(buffer),
        );
        this.#activeBufferHandle = manifest.activeBufferHandle;
        this.#dirty = confirmedDirtyBuffers.length > 0;
        this.#setSnapshot(
          "conflict",
          "The dirty-buffer set changed before Discard All. Review it and confirm again.",
          "disk",
        );
        return false;
      }
      const discarded = await session.discardAll(confirmedDirtyBuffers);
      if (!discarded || !this.#ownsOperation(ownership)) return false;
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) return false;
      if (this.#buffers.some((buffer) => buffer.modified)) {
        this.#setSnapshot(
          "conflict",
          "Neovim still has modified buffers after Discard All.",
          "disk",
        );
        return false;
      }
      await Promise.all(
        this.#buffers.flatMap((buffer) =>
          buffer.absolutePath
            ? [
                this.#captureBaseline(
                  buffer.absolutePath,
                  buffer.handle,
                  session,
                ),
              ]
            : [],
        ),
      );
      if (!this.#ownsOperation(ownership)) return false;
      await this.#refreshWorkspace(ownership);
      if (
        !this.#ownsOperation(ownership) ||
        this.#buffers.some((buffer) => buffer.modified)
      ) {
        if (this.#ownsOperation(ownership)) {
          this.#setSnapshot(
            "conflict",
            "Neovim gained modified buffers before Discard All completed.",
            "disk",
          );
        }
        return false;
      }
      this.#setSnapshot("ready", null);
      return true;
    } catch (error) {
      if (this.#ownsOperation(ownership)) {
        this.#setSnapshot(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    }
  }

  beginProjectPathMutation(): boolean {
    if (
      this.#projectPathMutationLocked ||
      this.#pendingTransitionGeneration !== null ||
      this.#recoveryOperation !== null
    ) {
      return false;
    }
    this.#projectPathMutationLocked = true;
    return true;
  }

  endProjectPathMutation(): void {
    this.#projectPathMutationLocked = false;
    this.#safeStartupFailure = null;
  }

  async synchronizePathRename(
    fromPath: string,
    toPath: string,
  ): Promise<BufferProviderPathMutationResult> {
    const session = this.#session;
    if (!session) return { ok: true, affectedBufferHandles: [] };
    const ownership = this.#captureOperationOwnership(session);
    let rebaseAttempted = false;
    try {
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          "the Neovim workspace changed before synchronization started",
        );
      }
      const source = workspaceMutationAbsolutePath(
        this.#workspaceRoot,
        fromPath,
      );
      const destination = workspaceMutationAbsolutePath(
        this.#workspaceRoot,
        toPath,
      );
      const affected = affectedFileBuffers(this.#buffers, source);
      const dirty = affected.filter((buffer) => buffer.modified);
      if (dirty.length > 0) {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          "one or more affected Neovim buffers became modified; save or discard them and retry",
        );
      }
      if (affected.length === 0) {
        return { ok: true, affectedBufferHandles: [] };
      }
      const changes = affected.map((buffer) => ({
        handle: buffer.handle,
        // The Lua guard compares against Neovim's exact live name. Keep that
        // spelling for the transactional precondition while using the
        // canonical absolutePath for host-side identity and subtree math.
        fromPath: buffer.name,
        toPath: resolve(
          destination,
          relative(source, canonicalNeovimPath(buffer.absolutePath!)),
        ),
      }));
      const stableSession = session as EmbeddedNeovimSession & {
        rebaseFileBuffers?: EmbeddedNeovimSession["rebaseFileBuffers"];
      };
      if (typeof stableSession.rebaseFileBuffers !== "function") {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          "the active Neovim session does not support loaded-buffer rebasing",
        );
      }
      rebaseAttempted = true;
      await stableSession.rebaseFileBuffers(changes);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          "the Neovim workspace changed during synchronization",
          false,
        );
      }
      for (const change of changes) {
        this.#fileSnapshots.delete(neovimFileSnapshotKey(change.fromPath));
      }
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          "the Neovim workspace changed before synchronization could be verified",
          false,
        );
      }
      const mismatched = changes.find((change) => {
        const buffer = this.#buffers.find(
          (candidate) => candidate.handle === change.handle,
        );
        return (
          !buffer?.loaded ||
          buffer.absolutePath === null ||
          !sameNeovimFilePath(buffer.absolutePath, change.toPath)
        );
      });
      if (mismatched) {
        return this.#pathMutationFailure(
          "rename",
          fromPath,
          `buffer ${mismatched.handle} did not confirm its new path ${this.#workspaceDisplayPath(mismatched.toPath)}`,
          false,
        );
      }
      this.#setSnapshot("ready", null);
      return {
        ok: true,
        affectedBufferHandles: changes.map((change) => change.handle),
      };
    } catch (error) {
      return this.#pathMutationFailure(
        "rename",
        fromPath,
        error,
        !rebaseAttempted,
      );
    }
  }

  async synchronizePathDelete(
    path: string,
  ): Promise<BufferProviderPathMutationResult> {
    const session = this.#session;
    if (!session) return { ok: true, affectedBufferHandles: [] };
    const ownership = this.#captureOperationOwnership(session);
    try {
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "delete",
          path,
          "the Neovim workspace changed before synchronization started",
        );
      }
      const target = workspaceMutationAbsolutePath(this.#workspaceRoot, path);
      const affected = affectedFileBuffers(this.#buffers, target);
      const dirty = affected.filter((buffer) => buffer.modified);
      if (dirty.length > 0) {
        return this.#pathMutationFailure(
          "delete",
          path,
          "one or more affected Neovim buffers became modified; save or discard them and retry",
        );
      }
      if (affected.length === 0) {
        return { ok: true, affectedBufferHandles: [] };
      }
      const deletions = affected.map((buffer) => ({
        handle: buffer.handle,
        // As with rename, preserve the exact editor-owned spelling for the Lua
        // precondition; snapshot cleanup below canonicalizes the key.
        path: buffer.name,
      }));
      const stableSession = session as EmbeddedNeovimSession & {
        deleteFileBuffers?: EmbeddedNeovimSession["deleteFileBuffers"];
      };
      if (typeof stableSession.deleteFileBuffers !== "function") {
        return this.#pathMutationFailure(
          "delete",
          path,
          "the active Neovim session does not support unloading deleted buffers",
        );
      }
      await stableSession.deleteFileBuffers(deletions);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "delete",
          path,
          "the Neovim workspace changed during synchronization",
        );
      }
      for (const deletion of deletions) {
        this.#fileSnapshots.delete(neovimFileSnapshotKey(deletion.path));
      }
      await this.#refreshWorkspace(ownership);
      if (!this.#ownsOperation(ownership)) {
        return this.#pathMutationFailure(
          "delete",
          path,
          "the Neovim workspace changed before synchronization could be verified",
        );
      }
      const stale = this.#buffers.find(
        (buffer) =>
          deletions.some((deletion) => deletion.handle === buffer.handle) ||
          (buffer.absolutePath !== null &&
            pathIsAtOrWithin(resolve(buffer.absolutePath), target)),
      );
      if (stale) {
        return this.#pathMutationFailure(
          "delete",
          path,
          `buffer ${stale.handle} still references the deleted path`,
        );
      }
      this.#setSnapshot("ready", null);
      return {
        ok: true,
        affectedBufferHandles: deletions.map((deletion) => deletion.handle),
      };
    } catch (error) {
      return this.#pathMutationFailure("delete", path, error);
    }
  }

  async shutdown(
    options: BufferProviderShutdownOptions = {},
  ): Promise<boolean> {
    return this.close({ discard: options.mode === "discard" });
  }

  async revert(): Promise<void> {
    if (this.#projectPathMutationLocked) return;
    const session = this.#session;
    if (!session) return;
    const ownership = this.#captureOperationOwnership(session);
    const previousSnapshot = this.#snapshot;
    const previousStatusMessage = this.#statusMessage;
    const reverted = await session.input("<Esc>:edit!<CR>");
    if (!this.#ownsOperation(ownership)) return;
    if (reverted === false) {
      this.#restoreActionableSnapshot(
        previousSnapshot,
        previousStatusMessage,
        "Embedded Neovim is closed; the file was not reverted.",
      );
      return;
    }
    await this.#refreshWorkspace(ownership);
    if (!this.#ownsOperation(ownership)) return;
    await this.#refreshFileSnapshot(this.#captureFileOwnership());
    this.#setSnapshot("ready", null);
  }

  async close(options: BufferProviderCloseOptions = {}): Promise<boolean> {
    if (this.#projectPathMutationLocked) {
      this.#setSnapshot(
        "conflict",
        "Wait for the current project rename or delete before closing BUFFER.",
      );
      return false;
    }
    if (this.#recoveryOperation) {
      this.#statusMessage =
        "Wait for the current recovery action before closing BUFFER.";
      this.#emitSnapshot();
      return false;
    }
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#pendingTransitionGeneration = generation;
    try {
      if (this.#pendingSessionStart) {
        try {
          await this.#cancelPendingSessionStart();
        } catch (error) {
          if (generation !== this.#openGeneration) return false;
          this.#setSnapshot(
            "error",
            cleanupError("while closing BUFFER", error).message,
          );
          return false;
        }
      }
      if (generation !== this.#openGeneration) return false;
      const session = this.#session;
      if (!session) {
        this.#workspaceAuthorityRequired = false;
        this.#resetFileState();
        this.#setSnapshot("idle", null);
        return true;
      }
      let result: NeovimCloseResult;
      try {
        this.#exitExpected = true;
        result = await session.quit(options.discard === true);
      } catch (error) {
        this.#exitExpected = false;
        if (generation !== this.#openGeneration) return false;
        this.#setSnapshot(
          "error",
          cleanupError("while closing BUFFER", error).message,
        );
        return false;
      }
      if (generation !== this.#openGeneration) return false;
      if (!result.closed) {
        this.#exitExpected = false;
        if (result.dirtyState === "dirty") this.#dirty = true;
        this.#setSnapshot("conflict", result.reason);
        return false;
      }
      this.#releaseSession(session);
      this.#workspaceAuthorityRequired = false;
      this.#resetFileState();
      this.#setSnapshot("idle", null);
      return true;
    } finally {
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
    }
  }

  async openExternalEditor(): Promise<boolean> {
    if (this.#projectPathMutationLocked) {
      this.#setSnapshot(
        "conflict",
        "Wait for the current project rename or delete before opening an external editor.",
      );
      return false;
    }
    if (
      this.#pendingTransitionGeneration !== null ||
      this.#pendingSessionStart !== null
    ) {
      return false;
    }
    const session = this.#session;
    const fileOwnership = this.#captureFileOwnership();
    if (!fileOwnership.absolutePath) return false;
    const sessionOwnership = session
      ? this.#captureOperationOwnership(session)
      : null;
    let dirty = this.#dirty;
    if (sessionOwnership) {
      try {
        // External handoff must cover hidden buffers as well as the active
        // buffer: launching first and relying on a later :qa refusal would let
        // another editor race unsaved in-memory state.
        dirty = await sessionOwnership.session.hasUnsavedBuffers();
      } catch (error) {
        if (
          this.#ownsOperation(sessionOwnership) &&
          this.#ownsFile(fileOwnership)
        ) {
          this.#setSnapshot(
            "error",
            `Unable to verify embedded Neovim dirty state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return false;
      }
      if (!this.#ownsOperation(sessionOwnership)) return false;
    }
    if (!this.#ownsFile(fileOwnership)) return false;
    this.#dirty = dirty;
    if (dirty) {
      this.#setSnapshot(
        "conflict",
        "Save or force quit embedded Neovim edits before opening an external editor.",
      );
      return false;
    }
    const line = this.#terminal.cursor.row + 1;
    let opened = false;
    try {
      opened = this.#openExternalEditor(fileOwnership.absolutePath, line);
    } catch (error) {
      if (this.#ownsFile(fileOwnership)) {
        this.#setSnapshot(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    }
    if (!this.#ownsFile(fileOwnership)) return false;
    if (!opened) {
      this.#setSnapshot(
        "error",
        "No external editor is available for BUFFER. Set VISUAL or EDITOR.",
      );
      return false;
    }
    if (sessionOwnership) {
      const reloaded = await sessionOwnership.session
        .input("<Esc>:edit!<CR>")
        .catch(() => false);
      if (!reloaded || !this.#ownsOperation(sessionOwnership)) return false;
      this.#fileSnapshots.delete(
        neovimFileSnapshotKey(fileOwnership.absolutePath),
      );
    }
    await this.open({
      filePath: reloadPathAfterExternalEditor(
        fileOwnership.filePath,
        fileOwnership.absolutePath,
      ),
      line,
    });
    return true;
  }

  undo(): boolean {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (session) void this.#sendInput(session, "u");
    return true;
  }

  redo(): boolean {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (session) void this.#sendInput(session, "<C-r>");
    return true;
  }

  move(_move: BufferMove): boolean {
    return false;
  }

  async requestHover(): Promise<string | null> {
    return null;
  }

  async goToDefinition(): Promise<boolean> {
    return false;
  }

  handleInput(event: BufferProviderInput): boolean {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (!session) return false;
    if (event.isPaste === true) {
      void this.#runSessionAction(session, () => session.paste(event.input));
      return true;
    }
    const keys = translateKeyToNeovimInput(event.input, event.key);
    if (!keys) return false;
    void this.#sendInput(session, keys);
    return true;
  }

  click(row: number, column: number): boolean {
    if (this.#projectPathMutationLocked) return false;
    const session = this.#session;
    if (!session) return false;
    void this.#runSessionAction(session, () => session.click(row, column));
    return true;
  }

  resize(size: BufferProviderResize): void {
    this.#size = {
      rows: Math.max(1, Math.floor(size.rows)),
      columns: Math.max(1, Math.floor(size.columns)),
    };
    const session = this.#session;
    if (session)
      void this.#runSessionAction(session, () => session.resize(this.#size));
  }

  focus(focused: boolean): void {
    const session = this.#session;
    if (session)
      void this.#runSessionAction(session, () => session.focus(focused));
  }

  async cleanup(options: BufferProviderCleanupOptions = {}): Promise<void> {
    if (options.preserveRecovery === true) {
      this.#recoveryPreservationRequired = true;
    }
    const recoveryOperation = this.#recoveryOperation;
    if (recoveryOperation) await recoveryOperation;
    const generation = this.#openGeneration + 1;
    this.#openGeneration = generation;
    this.#pendingTransitionGeneration = generation;
    let session: EmbeddedNeovimSession | null = null;
    try {
      if (this.#pendingSessionStart) await this.#cancelPendingSessionStart();
      if (generation !== this.#openGeneration) return;
      if (this.#unconfirmedRecoveryExit !== null) {
        throw this.#unconfirmedRecoveryExit;
      }
      session = this.#session;
      this.#exitExpected = true;
      await session?.cleanup(options);
    } catch (error) {
      const failure = cleanupError("while releasing BUFFER", error);
      if (generation === this.#openGeneration)
        this.#setSnapshot("error", failure.message);
      throw failure;
    } finally {
      if (this.#pendingTransitionGeneration === generation) {
        this.#pendingTransitionGeneration = null;
      }
    }
    if (generation !== this.#openGeneration) return;
    if (session) this.#releaseSession(session);
    this.#exitExpected = false;
    this.#workspaceAuthorityRequired = false;
    this.#resetFileState();
    this.#setSnapshot("idle", null);
  }

  async #cancelPendingSessionStart(): Promise<void> {
    const pendingStart = this.#pendingSessionStart;
    if (!pendingStart) return;
    pendingStart.controller.abort(
      new Error("Embedded Neovim startup was superseded."),
    );
    await this.#disposePendingSessionStart(pendingStart);
  }

  async #disposePendingSessionStart(
    pendingStart: NeovimPendingSessionStart,
  ): Promise<void> {
    pendingStart.controller.abort(
      new Error("Embedded Neovim startup was superseded."),
    );
    if (pendingStart.disposalPromise) return pendingStart.disposalPromise;

    const attempt = (async () => {
      let session = pendingStart.session;
      if (!session) {
        try {
          session = await pendingStart.promise;
          pendingStart.session = session;
        } catch (error) {
          if (error instanceof NeovimStartupCleanupError) {
            try {
              await error.retryCleanup();
            } catch (retryError) {
              throw new AggregateError(
                [error, retryError],
                `${error.message}; startup cleanup retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                { cause: error },
              );
            }
            return;
          }
          if (pendingStart.controller.signal.aborted) return;
          throw error;
        }
      }
      try {
        await session.cleanup();
        if (this.#session === session) this.#releaseSession(session);
      } catch (error) {
        if (this.#session === null) {
          this.#session = session;
          this.#ownershipGeneration += 1;
        }
        throw error;
      }
    })();
    pendingStart.disposalPromise = attempt;
    try {
      await attempt;
      if (this.#pendingSessionStart === pendingStart)
        this.#pendingSessionStart = null;
    } finally {
      if (pendingStart.disposalPromise === attempt)
        pendingStart.disposalPromise = null;
    }
  }

  #resetFileState(): void {
    this.#ownershipGeneration += 1;
    this.#fileGeneration += 1;
    this.#filePath = null;
    this.#absolutePath = null;
    this.#fileSnapshot = null;
    this.#fileSnapshots.clear();
    this.#encoding = null;
    this.#lineEndings = null;
    this.#dirty = false;
    this.#buffers = [];
    this.#activeBufferHandle = null;
    this.#providerExit = null;
    this.#recovery = null;
    this.#activeRecovery = null;
    this.#queuedRecoveries = [];
    this.#workspaceRefreshQueued = false;
    this.#projectPathMutationLocked = false;
  }

  #captureOwnership(session: EmbeddedNeovimSession): NeovimProviderOwnership {
    return {
      generation: this.#ownershipGeneration,
      session,
    };
  }

  #captureOperationOwnership(
    session: EmbeddedNeovimSession,
  ): NeovimOperationOwnership {
    return {
      ...this.#captureOwnership(session),
      openGeneration: this.#openGeneration,
    };
  }

  #captureFileOwnership(): NeovimFileOwnership {
    return {
      generation: this.#fileGeneration,
      openGeneration: this.#openGeneration,
      filePath: this.#filePath,
      absolutePath: this.#absolutePath,
    };
  }

  #owns(ownership: NeovimProviderOwnership): boolean {
    return (
      ownership.generation === this.#ownershipGeneration &&
      ownership.session === this.#session
    );
  }

  #ownsOperation(ownership: NeovimOperationOwnership): boolean {
    return (
      ownership.openGeneration === this.#openGeneration && this.#owns(ownership)
    );
  }

  #ownsFile(ownership: NeovimFileOwnership): boolean {
    return (
      ownership.generation === this.#fileGeneration &&
      ownership.openGeneration === this.#openGeneration &&
      ownership.filePath === this.#filePath &&
      ownership.absolutePath === this.#absolutePath
    );
  }

  #setActiveFile(file: BufferFileSnapshot, preserveBaseline = false): void {
    const absolutePath = normalizeNeovimBufferPath(
      file.absolutePath,
      this.#workspaceRoot,
    );
    const normalizedFile = { ...file, absolutePath };
    const key = neovimFileSnapshotKey(absolutePath);
    const baseline = preserveBaseline
      ? (this.#fileSnapshots.get(key) ?? normalizedFile)
      : normalizedFile;
    this.#fileGeneration += 1;
    this.#filePath = baseline.filePath;
    this.#absolutePath = baseline.absolutePath;
    this.#fileSnapshot = baseline;
    this.#fileSnapshots.set(key, baseline);
    this.#encoding = baseline.encoding;
    this.#lineEndings = baseline.lineEndings;
  }

  async #sendInput(
    session: EmbeddedNeovimSession,
    keys: string,
  ): Promise<void> {
    await this.#runSessionAction(session, () => session.input(keys));
  }

  async #runSessionAction(
    session: EmbeddedNeovimSession,
    action: () => Promise<unknown>,
  ): Promise<void> {
    const ownership = this.#captureOperationOwnership(session);
    const pendingTransitionGeneration = this.#pendingTransitionGeneration;
    const sessionActionGate = this.#sessionActionGate;
    try {
      if (pendingTransitionGeneration !== null) {
        if (
          sessionActionGate === null ||
          sessionActionGate.generation !== pendingTransitionGeneration
        ) {
          return;
        }
        await sessionActionGate.promise;
        if (!sessionActionGate.allowActions) return;
      }
      if (!this.#ownsOperation(ownership)) return;
      await action();
    } catch (error) {
      if (this.#ownsOperation(ownership)) this.#setInputError(error);
    }
  }

  #beginSessionActionGate(generation: number): NeovimSessionActionGate {
    // A newer open supersedes both the previous transition and any editor
    // actions that were queued for its target file.
    this.#sessionActionGate?.release();
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate: NeovimSessionActionGate = {
      generation,
      promise,
      release,
      allowActions: false,
    };
    this.#sessionActionGate = gate;
    return gate;
  }

  #setInputError(error: unknown): void {
    this.#setSnapshot(
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }

  #restoreActionableSnapshot(
    snapshot: BufferProviderSnapshot,
    statusMessage: string | null,
    fallbackMessage: string,
  ): void {
    if (
      (snapshot.providerStatus === "error" ||
        snapshot.providerStatus === "conflict") &&
      snapshot.error
    ) {
      this.#snapshot = snapshot;
      this.#statusMessage = statusMessage;
      this.#emit();
      return;
    }
    this.#setSnapshot("error", fallbackMessage);
  }

  #pathMutationFailure(
    mutation: "rename" | "delete",
    path: string,
    error: unknown,
    diskRollbackSafe = true,
  ): Extract<BufferProviderPathMutationResult, { readonly ok: false }> {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `Embedded Neovim could not synchronize the project ${mutation} for ${path}: ${detail}.`;
    this.#setSnapshot("error", reason);
    return { ok: false, reason, diskRollbackSafe };
  }

  #handleRecoveryDetected(recovery: {
    readonly swapFile: string;
    readonly filePath: string;
  }): void {
    const activeRecovery = this.#activeRecovery;
    if (activeRecovery) {
      if (activeRecovery.swapFile === recovery.swapFile) return;
      if (
        !this.#queuedRecoveries.some(
          (queued) => queued.swapFile === recovery.swapFile,
        )
      ) {
        this.#queuedRecoveries.push(recovery);
      }
      this.#statusMessage = `Resolve recovery for ${activeRecovery.filePath} first; recovery for ${recovery.filePath} remains queued.`;
      this.#emitSnapshot();
      return;
    }

    this.#activeRecovery = recovery;
    this.#recovery = {
      status: "pending",
      swapFiles: [recovery.swapFile],
    };
    this.#statusMessage = `Unsaved Neovim recovery data was found for ${recovery.filePath}.`;
    this.#emitSnapshot();
  }

  #handleDirtyChange(dirty: boolean): void {
    const session = this.#session;
    if (!session) return;
    const ownership = this.#captureOwnership(session);
    this.#dirty = dirty;
    this.#emitSnapshot();
    this.#scheduleWorkspaceRefresh(ownership);
  }

  #releaseSession(session: EmbeddedNeovimSession): void {
    if (this.#session !== session) return;
    this.#session = null;
    this.#ownershipGeneration += 1;
  }

  #scheduleWorkspaceRefresh(ownership: NeovimProviderOwnership): void {
    if (!this.#owns(ownership)) return;
    if (this.#workspaceRefreshPromise) {
      this.#workspaceRefreshQueued = true;
      return;
    }
    const refresh = this.#refreshWorkspace(ownership)
      .catch((error) => {
        if (this.#owns(ownership)) {
          this.#setSnapshot(
            "error",
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (this.#workspaceRefreshPromise !== refresh) return;
        this.#workspaceRefreshPromise = null;
        if (this.#workspaceRefreshQueued) {
          this.#workspaceRefreshQueued = false;
          this.#scheduleWorkspaceRefresh(ownership);
        }
      });
    this.#workspaceRefreshPromise = refresh;
  }

  async #refreshWorkspace(
    ownership: NeovimProviderOwnership | NeovimOperationOwnership,
  ): Promise<void> {
    const manifest = await this.#inspectSessionBuffers(ownership.session);
    if (!this.#owns(ownership)) return;
    const buffers = manifest.buffers.map((buffer) =>
      this.#providerBuffer(buffer),
    );
    this.#buffers = buffers;
    this.#activeBufferHandle = manifest.activeBufferHandle;
    this.#dirty = buffers.some((buffer) => buffer.modified);

    const active =
      buffers.find((buffer) => buffer.handle === manifest.activeBufferHandle) ??
      buffers.find((buffer) => buffer.current);
    if (active) {
      const changedActivePath =
        active.absolutePath === null || this.#absolutePath === null
          ? active.absolutePath !== this.#absolutePath
          : !sameNeovimFilePath(active.absolutePath, this.#absolutePath);
      if (changedActivePath) this.#fileGeneration += 1;
      this.#absolutePath = active.absolutePath;
      this.#filePath = active.filePath;
      const baseline = active.absolutePath
        ? (this.#fileSnapshots.get(
            neovimFileSnapshotKey(active.absolutePath),
          ) ?? null)
        : null;
      this.#fileSnapshot = baseline;
      this.#encoding = baseline?.encoding ?? null;
      this.#lineEndings = baseline?.lineEndings ?? null;
    }
    this.#emitSnapshot();

    const cleanUnknownBuffers = buffers.filter(
      (buffer) =>
        !buffer.modified &&
        buffer.absolutePath !== null &&
        !this.#fileSnapshots.has(neovimFileSnapshotKey(buffer.absolutePath)),
    );
    await Promise.all(
      cleanUnknownBuffers.map((buffer) =>
        this.#captureBaseline(
          buffer.absolutePath!,
          buffer.handle,
          ownership.session,
        ),
      ),
    );
    if (this.#owns(ownership)) this.#emitSnapshot();
  }

  async #inspectSessionBuffers(session: EmbeddedNeovimSession): Promise<{
    readonly activeBufferHandle: number | null;
    readonly buffers: readonly EmbeddedNeovimBuffer[];
  }> {
    const stableSession = session as EmbeddedNeovimSession & {
      inspectBuffers?: EmbeddedNeovimSession["inspectBuffers"];
      hasUnsavedBuffers?: EmbeddedNeovimSession["hasUnsavedBuffers"];
      isDirty?: EmbeddedNeovimSession["isDirty"];
    };
    if (typeof stableSession.inspectBuffers === "function") {
      return stableSession.inspectBuffers();
    }
    const dirty =
      typeof stableSession.hasUnsavedBuffers === "function"
        ? await stableSession.hasUnsavedBuffers()
        : typeof stableSession.isDirty === "function"
          ? await stableSession.isDirty()
          : this.#dirty;
    if (!this.#absolutePath && !this.#filePath) {
      return { activeBufferHandle: null, buffers: [] };
    }
    return {
      activeBufferHandle: 0,
      buffers: [
        {
          handle: 0,
          changedtick: null,
          endOfLine: null,
          name: this.#absolutePath ?? this.#filePath ?? "",
          listed: true,
          loaded: true,
          modified: dirty,
          current: true,
          bufferType: "",
          modifiable: true,
          readOnly: false,
          saveable: this.#absolutePath !== null,
        },
      ],
    };
  }

  #workspaceCaptureCandidates(
    buffers: readonly EmbeddedNeovimBuffer[],
  ): readonly NeovimWorkspaceCaptureCandidate[] {
    const candidates: NeovimWorkspaceCaptureCandidate[] = [];
    const seenPaths = new Set<string>();
    for (const buffer of buffers) {
      if (
        !buffer.loaded ||
        buffer.bufferType !== "" ||
        buffer.name.length === 0
      ) {
        continue;
      }
      const path = normalizeNeovimBufferPath(buffer.name, this.#workspaceRoot);
      if (
        this.#workspaceRoot !== undefined &&
        !canonicalNeovimPathIsAtOrWithin(path, this.#workspaceRoot)
      ) {
        continue;
      }
      if (
        buffer.changedtick === null ||
        !Number.isSafeInteger(buffer.changedtick) ||
        buffer.changedtick < 0
      ) {
        throw new Error(
          `Neovim buffer ${buffer.handle} has no stable changedtick for workspace synchronization.`,
        );
      }
      if (buffer.endOfLine === null) {
        throw new Error(
          `Neovim buffer ${buffer.handle} has no stable end-of-line state for workspace synchronization.`,
        );
      }
      const pathKey = canonicalNeovimPathKey(path);
      if (seenPaths.has(pathKey)) {
        throw new Error(
          `Neovim reports duplicate loaded buffers for ${path}; workspace synchronization is ambiguous.`,
        );
      }
      seenPaths.add(pathKey);
      candidates.push({
        handle: buffer.handle,
        path,
        changedtick: buffer.changedtick,
        endOfLine: buffer.endOfLine,
        modified: buffer.modified,
      });
    }
    return candidates.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.handle - right.handle,
    );
  }

  async #authorizeWorkspaceWrite(
    request: BufferWorkspaceWriteRequest,
  ): Promise<BufferWorkspaceWriteDecision> {
    const handler = this.#workspaceWriteAuthorityHandler;
    if (handler === null) {
      return {
        allowed: false,
        reason: "The authoritative workspace synchronizer is not ready.",
      };
    }
    const targetPath = normalizeNeovimBufferPath(
      request.target.path,
      this.#workspaceRoot,
    );
    const sourcePath = normalizeNeovimBufferPath(
      request.target.sourcePath,
      this.#workspaceRoot,
    );
    if (
      this.#workspaceRoot !== undefined &&
      !canonicalNeovimPathIsAtOrWithin(targetPath, this.#workspaceRoot)
    ) {
      // AgenC's daemon authority is scoped to the workspace. Do not claim or
      // delay unrelated files opened deliberately from the same Neovim.
      return { allowed: true };
    }

    const buffers: BufferWorkspaceBufferCapture[] = [];
    const seenPaths = new Set<string>();
    let targetMatched = false;
    for (const buffer of request.buffers) {
      const path = normalizeNeovimBufferPath(buffer.path, this.#workspaceRoot);
      if (
        this.#workspaceRoot !== undefined &&
        !canonicalNeovimPathIsAtOrWithin(path, this.#workspaceRoot)
      ) {
        continue;
      }
      const pathKey = canonicalNeovimPathKey(path);
      if (seenPaths.has(pathKey)) {
        return {
          allowed: false,
          reason: `Neovim reported duplicate loaded buffers for ${path}.`,
        };
      }
      seenPaths.add(pathKey);
      const normalized = { ...buffer, path };
      buffers.push(normalized);
      if (
        buffer.bufferHandle === request.target.bufferHandle &&
        sameNeovimFilePath(path, sourcePath) &&
        buffer.changedtick === request.target.changedtick &&
        buffer.endOfLine === request.target.endOfLine
      ) {
        targetMatched = true;
      }
    }
    if (!targetMatched) {
      return {
        allowed: false,
        reason:
          "The write target does not match the exact captured workspace manifest.",
      };
    }
    if (
      request.target.kind !== "buffer" ||
      !sameNeovimFilePath(targetPath, sourcePath)
    ) {
      return {
        allowed: false,
        reason:
          "Workspace range, alternate-path, and append writes are not supported because their destination bytes cannot yet be fenced exactly. Use :saveas for a full-buffer write.",
      };
    }
    return handler({
      target: {
        ...request.target,
        path: targetPath,
        sourcePath,
      },
      buffers: buffers.sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.bufferHandle - right.bufferHandle,
      ),
    });
  }

  #providerBuffer(buffer: EmbeddedNeovimBuffer): BufferProviderBuffer {
    // A named scratch/terminal/help buffer is still not a filesystem target.
    // Keeping non-file buffers out of the host path fields prevents synthetic
    // recovery diff panes such as "[disk] /workspace/file.ts" from becoming
    // clickable tabs or disk-baseline/save targets.
    const isFileBuffer = buffer.bufferType === "" && buffer.name.length > 0;
    const absolutePath = isFileBuffer
      ? normalizeNeovimBufferPath(buffer.name, this.#workspaceRoot)
      : null;
    const baseline = absolutePath
      ? this.#fileSnapshots.get(neovimFileSnapshotKey(absolutePath))
      : undefined;
    const currentFilePath =
      absolutePath &&
      this.#absolutePath &&
      sameNeovimFilePath(absolutePath, this.#absolutePath)
        ? this.#filePath
        : null;
    const displayPath = absolutePath
      ? this.#workspaceDisplayPath(absolutePath)
      : null;
    return {
      handle: buffer.handle,
      changedtick: buffer.changedtick,
      endOfLine: buffer.endOfLine,
      name: buffer.name,
      filePath: isFileBuffer
        ? (baseline?.filePath ?? currentFilePath ?? displayPath)
        : null,
      absolutePath,
      listed: buffer.listed,
      loaded: buffer.loaded,
      modified: buffer.modified,
      current: buffer.current,
      bufferType: buffer.bufferType,
      modifiable: buffer.modifiable,
      readOnly: buffer.readOnly,
      saveable: buffer.saveable,
    };
  }

  async #captureBaseline(
    absolutePath: string,
    handle?: number,
    session?: EmbeddedNeovimSession,
  ): Promise<void> {
    const normalizedAbsolutePath = normalizeNeovimBufferPath(
      absolutePath,
      this.#workspaceRoot,
    );
    try {
      const readFile = await this.#readFileSnapshot(normalizedAbsolutePath);
      const file = {
        ...readFile,
        absolutePath: normalizedAbsolutePath,
        filePath: this.#workspaceDisplayPath(normalizedAbsolutePath),
      };
      if (
        handle !== undefined &&
        session &&
        !(await this.#bufferMatchesSnapshot(session, handle, file))
      ) {
        return;
      }
      this.#fileSnapshots.set(
        neovimFileSnapshotKey(normalizedAbsolutePath),
        file,
      );
      if (
        this.#absolutePath &&
        sameNeovimFilePath(this.#absolutePath, normalizedAbsolutePath)
      ) {
        this.#fileSnapshot = file;
        this.#encoding = file.encoding;
        this.#lineEndings = file.lineEndings;
      }
    } catch {
      // A missing baseline is intentionally retained as unknown. Save and Save
      // All fail closed unless the caller explicitly forces the write.
    }
  }

  #workspaceDisplayPath(absolutePath: string): string {
    if (this.#workspaceRoot === undefined) return absolutePath;
    const workspaceRoot = canonicalNeovimPath(this.#workspaceRoot);
    const resolvedPath = canonicalNeovimPath(absolutePath, workspaceRoot);
    const workspaceRelativePath = relative(workspaceRoot, resolvedPath);
    if (
      workspaceRelativePath.length === 0 ||
      workspaceRelativePath === ".." ||
      workspaceRelativePath.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) ||
      isAbsolute(workspaceRelativePath)
    ) {
      return absolutePath;
    }
    return workspaceRelativePath.replaceAll("\\", "/");
  }

  async #assertNoDiskConflict(
    force: boolean,
    snapshot: BufferFileSnapshot | null,
  ): Promise<void> {
    if (force || !snapshot) return;
    const current = await this.#readFileSnapshot(snapshot.absolutePath).catch(
      () => {
        throw new BufferSaveConflictError(snapshot.filePath);
      },
    );
    if (
      current.mtimeMs !== snapshot.mtimeMs ||
      current.content !== snapshot.content
    ) {
      throw new BufferSaveConflictError(snapshot.filePath);
    }
  }

  async #refreshFileSnapshot(ownership: NeovimFileOwnership): Promise<void> {
    const paths = refreshableFileSnapshotPaths(
      ownership.absolutePath,
      ownership.filePath,
    );
    if (!paths) return;
    try {
      const file = await this.#readFileSnapshot(paths.absolutePath);
      if (!this.#ownsFile(ownership)) return;
      const absolutePath = normalizeNeovimBufferPath(
        paths.absolutePath,
        this.#workspaceRoot,
      );
      const key = neovimFileSnapshotKey(absolutePath);
      const normalized = {
        ...file,
        absolutePath,
        filePath: paths.filePath,
      };
      const session = this.#session;
      const activeBufferHandle = this.#activeBufferHandle;
      if (
        session &&
        activeBufferHandle !== null &&
        !(await this.#bufferMatchesSnapshot(
          session,
          activeBufferHandle,
          normalized,
        ))
      ) {
        if (!this.#ownsFile(ownership)) return;
        const previous = this.#fileSnapshots.get(key);
        if (previous && sameDiskSnapshot(previous, normalized)) {
          // A dirty or recovered buffer is expected to differ from disk. Keep
          // its pre-edit baseline while the disk snapshot itself is unchanged
          // so the next provider save can still perform a real conflict check.
          this.#fileSnapshot = previous;
          this.#encoding = previous.encoding;
          this.#lineEndings = previous.lineEndings;
          return;
        }
        this.#fileSnapshots.delete(key);
        this.#fileSnapshot = null;
        this.#encoding = null;
        this.#lineEndings = null;
        return;
      }
      if (!this.#ownsFile(ownership)) return;
      this.#fileSnapshot = normalized;
      this.#fileSnapshots.set(key, normalized);
      this.#encoding = file.encoding;
      this.#lineEndings = file.lineEndings;
    } catch {
      return;
    }
  }

  async #bufferMatchesSnapshot(
    session: EmbeddedNeovimSession,
    handle: number,
    snapshot: BufferFileSnapshot,
  ): Promise<boolean> {
    const readableSession = session as EmbeddedNeovimSession & {
      readBufferText?: (handle: number) => Promise<string>;
    };
    if (typeof readableSession.readBufferText !== "function") return true;
    try {
      return (
        (await readableSession.readBufferText(handle)) === snapshot.content
      );
    } catch {
      return false;
    }
  }

  #setSnapshot(
    status: BufferProviderSnapshot["providerStatus"],
    message: string | null,
    conflictKind: BufferProviderSnapshot["conflictKind"] = status === "conflict"
      ? "disk"
      : null,
  ): void {
    this.#statusMessage = message;
    this.#snapshot = {
      ...this.#snapshot,
      status: status === "closed" ? "idle" : status,
      providerStatus: status,
      workspaceAuthorityRequired: this.#workspaceAuthorityRequired,
      providerMessage: message,
      error: status === "error" || status === "conflict" ? message : null,
      conflictKind,
      filePath: this.#filePath,
      absolutePath: this.#absolutePath,
      dirty: this.#dirty,
      lineCount: this.#terminal.lines.length,
      position: positionFromNeovimCursor(
        this.#terminal.cursor.row + 1,
        this.#terminal.cursor.column,
      ),
      selection: { anchor: 0, head: 0 },
      viewportRows: this.#size.rows,
      encoding: this.#encoding,
      lineEndings: this.#lineEndings,
      terminal: this.#terminal,
      vimMode: neovimModeToVimMode(this.#terminal.mode),
      vimCommandLine: this.#terminal.commandLine,
      buffers: this.#buffers,
      activeBufferHandle: this.#activeBufferHandle,
      dirtyBufferCount: this.#buffers.filter((buffer) => buffer.modified)
        .length,
      providerExit: this.#providerExit,
      recovery: this.#recovery,
    };
    this.#emit();
  }

  #emitSnapshot(): void {
    this.#snapshot = {
      ...this.#snapshot,
      dirty: this.#dirty,
      providerMessage: this.#statusMessage,
      encoding: this.#encoding,
      lineEndings: this.#lineEndings,
      lineCount: this.#terminal.lines.length,
      position: positionFromNeovimCursor(
        this.#terminal.cursor.row + 1,
        this.#terminal.cursor.column,
      ),
      viewportRows: this.#size.rows,
      terminal: this.#terminal,
      vimMode: neovimModeToVimMode(this.#terminal.mode),
      vimCommandLine: this.#terminal.commandLine,
      buffers: this.#buffers,
      activeBufferHandle: this.#activeBufferHandle,
      dirtyBufferCount: this.#buffers.filter((buffer) => buffer.modified)
        .length,
      providerExit: this.#providerExit,
      recovery: this.#recovery,
    };
    this.#emit();
  }

  #emitIntegrationIntent(intent: BufferIntegrationIntent): void {
    for (const listener of this.#integrationIntentListeners) listener(intent);
  }

  #emitCodePredictionFeedback(feedback: BufferCodePredictionFeedback): void {
    for (const listener of this.#codePredictionFeedbackListeners) {
      listener(feedback);
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function saveAllManifestChangeReason(
  expectedDirty: readonly EmbeddedNeovimBuffer[],
  liveBuffers: readonly EmbeddedNeovimBuffer[],
): string | null {
  const liveDirty = liveBuffers.filter((buffer) => buffer.modified);
  if (liveDirty.length !== expectedDirty.length) {
    return "The Neovim dirty-buffer set changed during Save All; no unreviewed buffer was written.";
  }
  const liveByHandle = new Map(
    liveDirty.map((buffer) => [buffer.handle, buffer]),
  );
  for (const expected of expectedDirty) {
    const live = liveByHandle.get(expected.handle);
    if (
      !live ||
      live.name !== expected.name ||
      live.changedtick !== expected.changedtick
    ) {
      return `Neovim buffer ${expected.handle} changed during Save All before it could be written.`;
    }
  }
  return null;
}

function discardManifestFingerprint(
  dirtyBuffers: readonly EmbeddedNeovimBuffer[],
): string {
  return JSON.stringify(
    [...dirtyBuffers]
      .sort((left, right) => left.handle - right.handle)
      .map((buffer) => [buffer.handle, buffer.name, buffer.changedtick]),
  );
}

function sameWorkspaceCaptureManifest(
  left: readonly NeovimWorkspaceCaptureCandidate[],
  right: readonly NeovimWorkspaceCaptureCandidate[],
): boolean {
  return (
    left.length === right.length &&
    left.every((buffer, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        buffer.handle === other.handle &&
        buffer.path === other.path &&
        buffer.changedtick === other.changedtick &&
        buffer.endOfLine === other.endOfLine &&
        buffer.modified === other.modified
      );
    })
  );
}

export function reloadPathAfterExternalEditor(
  filePath: string | null,
  absolutePath: string,
): string {
  return filePath ?? absolutePath;
}

export function normalizeNeovimBufferPath(
  bufferName: string,
  workspaceRoot?: string,
): string {
  return canonicalNeovimPath(
    bufferName,
    workspaceRoot && workspaceRoot.trim().length > 0
      ? workspaceRoot
      : undefined,
  );
}

export function neovimFileSnapshotKey(absolutePath: string): string {
  return canonicalNeovimPathKey(absolutePath);
}

function sameNeovimFilePath(left: string, right: string): boolean {
  return neovimFileSnapshotKey(left) === neovimFileSnapshotKey(right);
}

function sameDiskSnapshot(
  left: BufferFileSnapshot,
  right: BufferFileSnapshot,
): boolean {
  return left.mtimeMs === right.mtimeMs && left.content === right.content;
}

export function refreshableFileSnapshotPaths(
  absolutePath: string | null,
  filePath: string | null,
): { readonly absolutePath: string; readonly filePath: string } | null {
  return absolutePath && filePath ? { absolutePath, filePath } : null;
}

export function workspaceMutationAbsolutePath(
  workspaceRoot: string | undefined,
  candidatePath: string,
): string {
  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new Error("the BUFFER workspace root is unavailable");
  }
  if (candidatePath.trim().length === 0) {
    throw new Error("the project mutation path is empty");
  }
  const root = canonicalNeovimPath(workspaceRoot);
  const candidate = canonicalNeovimPath(candidatePath, root);
  if (!pathIsAtOrWithin(candidate, root)) {
    throw new Error(
      `the project mutation path is outside the BUFFER workspace: ${candidatePath}`,
    );
  }
  return candidate;
}

function affectedFileBuffers(
  buffers: readonly BufferProviderBuffer[],
  targetPath: string,
): readonly BufferProviderBuffer[] {
  return buffers.filter(
    (buffer) =>
      buffer.loaded &&
      buffer.bufferType === "" &&
      buffer.absolutePath !== null &&
      pathIsAtOrWithin(resolve(buffer.absolutePath), targetPath),
  );
}

function pathIsAtOrWithin(candidatePath: string, parentPath: string): boolean {
  return canonicalNeovimPathIsAtOrWithin(candidatePath, parentPath);
}

function neovimModeToVimMode(mode: string): BufferProviderSnapshot["vimMode"] {
  if (mode.startsWith("insert")) return "INSERT";
  if (mode.startsWith("visual") || mode === "v" || mode === "V")
    return "VISUAL";
  return "NORMAL";
}

function cleanupError(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Embedded Neovim cleanup failed ${context}: ${message}`, {
    cause: error,
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupExitFailure(exit: NeovimExitInfo | null): Error {
  const detail = exit?.stderrTail
    ? `: ${exit.stderrTail}`
    : exit?.signal
      ? ` (${exit.signal})`
      : exit !== null && exit.code !== null && exit.code !== 0
        ? ` (exit ${exit.code})`
        : "";
  return new Error(`Embedded Neovim exited during startup${detail}.`);
}
