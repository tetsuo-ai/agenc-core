import type { LLMMessage } from "../llm/types.js";
import type { AgenCConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import type { Event } from "../session/event-log.js";
import type { HistoryReplacedEvent } from "../session/transcript-replacement.js";
import type { SessionServices } from "../session/session.js";
import type { ApprovalResolver } from "../tools/orchestrator.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type { UserPromptSubmitHook } from "../hooks/user-prompt-submit.js";
import type { MCPServerConnection } from "../services/mcp/types.js";
import type { PhaseEvent } from "../phases/events.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import type { AgenCRealtimeTuiControls } from "./realtime/controller.js";
import type { FpsMetrics } from "../utils/fpsTracker.js";
import type { AgentRoleWorkspace } from "../agents/role-workspace.js";

export interface AgenCCompactProgressControls {
  setStreamMode?(mode: "requesting" | "responding" | null): void;
  setResponseLength?(updater: (length: number) => number): void;
  onCompactProgress?(event: unknown): void;
  setSDKStatus?(status: "compacting" | null): void;
}

export interface PermissionModeRegistryLike {
  current(): ToolPermissionContext;
  update?(next: ToolPermissionContext): Promise<void> | void;
  subscribeToModeChange?(
    cb: (
      next: ToolPermissionContext["mode"],
      previous: ToolPermissionContext["mode"],
    ) => void,
  ): () => void;
}

export interface AgenCBridgeSession extends AgenCCompactProgressControls {
  readonly conversationId: string;
  /** Immutable role-discovery identity; execution cwd may move independently. */
  readonly roleWorkspace?: Pick<AgentRoleWorkspace, "id" | "cwd">;
  readonly agentDefinitions?: {
    readonly agentRoleWorkspaceId: string;
    readonly activeAgents: readonly unknown[];
    readonly allAgents?: readonly unknown[];
    readonly allowedAgentTypes?: readonly unknown[];
  };
  readonly services: {
    readonly permissionModeRegistry: PermissionModeRegistryLike;
    readonly sandboxExecutionBroker?: SessionServices["sandboxExecutionBroker"];
    readonly configStore?: ConfigStore;
    readonly authManager?: SessionServices["authManager"];
    readonly mcpManager?: SessionServices["mcpManager"];
    readonly skillsManager?: SessionServices["skillsManager"];
    readonly skillsWatcher?: SessionServices["skillsWatcher"];
    readonly pluginsManager?: SessionServices["pluginsManager"];
    readonly hooks?: {
      readonly userPromptSubmitHooks?: readonly UserPromptSubmitHook[];
    };
    approvalResolver?: ApprovalResolver;
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
  };
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  readonly state?: {
    unsafePeek(): unknown;
  };
  readonly abortController?: { readonly signal: AbortSignal };
  readonly eventLog?: {
    subscribe(cb: (event: Event) => void): () => void;
  };
  readonly initialTranscriptEvents?: readonly unknown[];
  getInitialTranscriptEvents?(): readonly unknown[];
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  emitPhaseEvent?(event: PhaseEvent): void;
  clearDaemonSession?(): Promise<void>;
  resolveDaemonToolCall?(params: {
    readonly toolCallId?: string;
    readonly reviewer?: string;
  }): Promise<{
    readonly sessionId: string;
    readonly resolved: readonly {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly eventId?: string;
    }[];
    readonly remaining: number;
  }>;
  getDaemonSessionSnapshot?(): Promise<{
    readonly sessionId: string;
    readonly turnCount: number;
    readonly tokenUsage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly costUsd: number;
    };
    readonly cacheStats: {
      readonly requestCount: number;
      readonly cacheReadInputTokens: number;
      readonly cacheCreationInputTokens: number;
      readonly cacheTotalInputTokens: number;
      readonly hitRate: number | null;
    };
  }>;
  partialCompactFromMessage?(params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly ok: true;
        readonly sessionId: string;
        readonly eventAlreadyEmitted: boolean;
        readonly event?: HistoryReplacedEvent;
        readonly displayText?: string;
      }
    | {
        readonly ok: false;
        readonly sessionId: string;
        readonly eventAlreadyEmitted: boolean;
        readonly code?: string;
        readonly message: string;
      }
  >;
  rewindConversationToMessage?(params: {
    readonly messageOrdinal: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly sessionId: string;
        readonly eventAlreadyEmitted: boolean;
        readonly event?: HistoryReplacedEvent;
        readonly displayText?: string;
      }
    | {
        readonly ok: false;
        readonly sessionId: string;
        readonly eventAlreadyEmitted: boolean;
        readonly code?: string;
        readonly message: string;
      }
  >;
  previewFileRewind?(params: { readonly messageOrdinal: number }): Promise<{
    readonly ok: boolean;
    readonly sessionId: string;
    readonly code?: string;
    readonly message?: string;
    readonly canRestoreFiles?: boolean;
    readonly filesChanged?: readonly string[];
    readonly insertions?: number;
    readonly deletions?: number;
  }>;
  rewindFilesToMessage?(params: { readonly messageOrdinal: number }): Promise<{
    readonly ok: boolean;
    readonly sessionId: string;
    readonly code?: string;
    readonly message?: string;
    readonly restoredFiles?: readonly string[];
    readonly displayText?: string;
  }>;
  readonly realtime?: AgenCRealtimeTuiControls;
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput?(input: LLMMessage): number;
  /**
   * Interrupt the active turn (if any) for this session. Used by the
   * TUI's CancelRequestHandler when the user presses ESC. Daemon-backed
   * sessions issue a `session.cancelTurn` RPC; in-process sessions can
   * fire their AbortController directly. No-op when the session is
   * idle.
   */
  cancelActiveTurn?(reason?: string): Promise<void>;
  abortTerminal?(reason: string): void;
  flushEventLog?(): Promise<void> | void;
  emit?(
    event: Event | { readonly kind: string; readonly [key: string]: unknown },
  ): void;
  nextInternalSubId?(): string;
  setDaemonPermissionMode?(mode: ToolPermissionContext["mode"]): Promise<unknown>;
  readonly sessionConfiguration?: {
    readonly cwd?: string;
    readonly collaborationMode?: { readonly model?: string };
    readonly provider?: { readonly slug?: string };
  };
  readonly config?: unknown;
  readonly cwd?: string;
  readonly home?: string;
  appStateBridge?: {
    getAppState?: () => unknown;
    setModel?: (next: string) => void;
    setExpandedView?: (next: "none" | "tasks") => void;
    setAppState?: (updater: (prev: unknown) => unknown) => void;
  };
  setPendingProviderSwitch?(
    pending: { provider: string; model: string; profile?: string } | null,
  ): void;
  listMcpClients?(): readonly MCPServerConnection[];
  listMcpTools?(): readonly unknown[];
}

type MutableCompactProgressSession = {
  setStreamMode?: AgenCCompactProgressControls["setStreamMode"];
  setResponseLength?: AgenCCompactProgressControls["setResponseLength"];
  onCompactProgress?: AgenCCompactProgressControls["onCompactProgress"];
  setSDKStatus?: AgenCCompactProgressControls["setSDKStatus"];
};

export function installCompactProgressControls(
  session: AgenCBridgeSession,
  controls: Required<AgenCCompactProgressControls>,
): () => void {
  const target = session as MutableCompactProgressSession;
  const previous = {
    setStreamMode: target.setStreamMode,
    setResponseLength: target.setResponseLength,
    onCompactProgress: target.onCompactProgress,
    setSDKStatus: target.setSDKStatus,
  };
  target.setStreamMode = controls.setStreamMode;
  target.setResponseLength = controls.setResponseLength;
  target.onCompactProgress = controls.onCompactProgress;
  target.setSDKStatus = controls.setSDKStatus;
  return () => {
    restoreCompactProgressControl(
      target,
      "setStreamMode",
      previous.setStreamMode,
    );
    restoreCompactProgressControl(
      target,
      "setResponseLength",
      previous.setResponseLength,
    );
    restoreCompactProgressControl(
      target,
      "onCompactProgress",
      previous.onCompactProgress,
    );
    restoreCompactProgressControl(
      target,
      "setSDKStatus",
      previous.setSDKStatus,
    );
  };
}

function restoreCompactProgressControl<
  Key extends keyof MutableCompactProgressSession,
>(
  target: MutableCompactProgressSession,
  key: Key,
  value: MutableCompactProgressSession[Key] | undefined,
): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

export interface ConfigStoreLike {
  readonly agencHome?: string;
  readonly snapshot?: unknown;
  current?(): AgenCConfig;
  reload?(): Promise<AgenCConfig>;
  subscribe?(listener: (config: unknown) => void): (() => void) | void;
  warnings?(): readonly string[];
}

export interface AgenCTuiProps {
  readonly session: AgenCBridgeSession;
  readonly configStore: ConfigStoreLike;
  readonly isInteractive?: boolean;
  readonly model?: string;
  readonly initialPrompt?: string;
  readonly initialComposerText?: string;
  readonly initialUserMessages?: readonly LLMMessage[];
  readonly getFpsMetrics?: () => FpsMetrics | undefined;
}
