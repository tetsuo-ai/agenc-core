/**
 * WebChat channel type definitions.
 *
 * Defines the configuration, dependency injection interface, and WebSocket
 * protocol message types for the WebChat channel plugin.
 *
 * @module
 */

// Re-export the canonical WebChatHandler from gateway/types to avoid duplication
export type { WebChatHandler } from "../../gateway/types.js";
export type { SessionResumabilityState } from "../../gateway/watch-cockpit.js";
import type { GatewayStatus } from "../../gateway/types.js";
import type {
  HookDispatcher,
  HookEvent,
  HookHandlerKind,
  HookHandlerSource,
  HookHandlerType,
} from "../../gateway/hooks.js";
import type {
  BackgroundRunOperatorAvailability,
  BackgroundRunControlAction,
  BackgroundRunOperatorDetail,
  BackgroundRunOperatorSummary,
} from "../../gateway/background-run-operator.js";
import type {
  ObservabilityArtifactResponse,
  ObservabilityLogResponse,
  ObservabilitySummary,
  ObservabilitySummaryQuery,
  ObservabilityTraceDetail,
  ObservabilityTraceQuery,
  ObservabilityTraceSummary,
} from "../../observability/types.js";
import type { WatchCockpitSnapshot } from "../../gateway/watch-cockpit.js";
import type {
  ReviewSurfaceState,
  SessionResumabilityState,
  VerificationSurfaceState,
  VerificationVerdict,
} from "../../gateway/watch-cockpit.js";
import type { SessionShellProfile } from "../../gateway/shell-profile.js";
import type { SessionWorkflowState } from "../../gateway/workflow-state.js";
import type { SlashCommandRegistry } from "../../gateway/commands.js";
import type { ActiveTaskContext } from "../../llm/turn-execution-contract-types.js";

// ============================================================================
// WebChatDeps (dependency injection)
// ============================================================================

/**
 * Dependencies injected into the WebChatChannel at construction time.
 */
export interface WebChatSkillListEntry {
  name: string;
  description: string;
  enabled: boolean;
  available?: boolean;
  tier?: string;
  sourcePath?: string;
  tags?: string[];
  primaryEnv?: string;
  unavailableReason?: string;
  missingRequirements?: string[];
}

export interface WebChatHookListEntry {
  event: HookEvent;
  name: string;
  priority: number;
  source: HookHandlerSource;
  kind: HookHandlerKind;
  handlerType: HookHandlerType;
  target?: string;
  supported: boolean;
}

export interface SessionContinuityRecord {
  readonly sessionId: string;
  readonly label: string;
  readonly preview: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActiveAt: number;
  readonly connected: boolean;
  readonly resumabilityState: SessionResumabilityState;
  readonly shellProfile: SessionShellProfile;
  readonly workflowStage: SessionWorkflowState["stage"];
  readonly workspaceRoot?: string;
  readonly repoRoot?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly activeTaskSummary?: string;
  readonly childSessionCount: number;
  readonly worktreeCount: number;
  readonly pendingApprovalCount: number;
  readonly lastAssistantOutputPreview?: string;
  readonly forkLineage?: {
    readonly parentSessionId: string;
    readonly source: string;
    readonly forkedAt: number;
  };
}

export interface SessionHistoryItem {
  readonly content: string;
  readonly sender: "user" | "agent" | "tool";
  readonly timestamp: number;
  readonly toolName?: string;
}

export interface SessionContinuityDetail extends SessionContinuityRecord {
  readonly workflowState: SessionWorkflowState;
  readonly runtimeState?: {
    readonly activeTaskContext?: ActiveTaskContext;
    readonly reviewStatus?: ReviewSurfaceState["status"];
    readonly verificationStatus?: VerificationSurfaceState["status"];
    readonly verificationVerdict?: VerificationVerdict;
  };
  readonly recentHistory?: readonly SessionHistoryItem[];
  readonly backgroundRun?: {
    readonly runId: string;
    readonly state: BackgroundRunOperatorSummary["state"];
    readonly currentPhase?: BackgroundRunOperatorSummary["currentPhase"];
    readonly objective?: string;
    readonly checkpointAvailable?: boolean;
  };
}

export interface SessionResumePayload {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly workspaceRoot?: string;
  readonly shellProfile?: SessionShellProfile;
}

export interface SessionForkResult {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly forkSource?: string;
  readonly session?: SessionContinuityRecord;
}

export interface WebChatDeps {
  /** Gateway instance for status queries. */
  gateway: {
    getStatus(): GatewayStatus;
    config: {
      agent?: { name?: string };
      connection?: { rpcUrl?: string; keypairPath?: string };
      llm?: { provider?: string; model?: string };
      autonomy?: unknown;
    };
  };
  /** Optional policy-scope resolver for session-scoped rollout/catalog decisions. */
  resolvePolicyScopeForSession?: (params: {
    sessionId: string;
    channel: string;
  }) => {
    tenantId?: string;
    projectId?: string;
  };
  /** Optional daemon-level status for operator memory/process panels. */
  getDaemonStatus?: () => {
    pid: number;
    uptimeMs: number;
    memoryUsage: {
      heapUsedMB: number;
      rssMB: number;
    };
  };
  /** Optional tool listing for tools.list handler. */
  skills?: ReadonlyArray<WebChatSkillListEntry>;
  /** Optional hook listing for hooks.list handler. */
  hooks?: HookDispatcher;
  /** Optional voice bridge for real-time voice sessions. */
  voiceBridge?: import("../../gateway/voice-bridge.js").VoiceBridge;
  /** Optional memory backend for memory.search / memory.sessions handlers. */
  memoryBackend?: import("../../memory/types.js").MemoryBackend;
  /** Optional approval engine for approval.respond handler. */
  approvalEngine?: import("../../gateway/approvals.js").ApprovalEngine;
  /** Optional callback to toggle a skill's enabled state. */
  skillToggle?: (name: string, enabled: boolean) => void;
  /** Optional Solana connection for on-chain task operations. */
  connection?: import("@solana/web3.js").Connection;
  /** Optional callback to broadcast events to all subscribed WS clients. */
  broadcastEvent?: (eventType: string, data: Record<string, unknown>) => void;
  /** Optional desktop sandbox manager for desktop.* handlers. */
  desktopManager?: import("../../desktop/manager.js").DesktopSandboxManager;
  /**
   * Optional callback fired before re-binding a web session to another desktop
   * container so per-session desktop bridges can be recycled safely.
   */
  onDesktopSessionRebound?: (sessionId: string) => void;
  /** Optional callback to fully reset backend context for a web session. */
  resetSessionContext?: (sessionId: string) => Promise<void> | void;
  /** Optional callback to rehydrate backend context for a resumed web session. */
  hydrateSessionContext?: (sessionId: string) => Promise<void> | void;
  /** Optional callback to cancel a daemon-owned background run for a session. */
  cancelBackgroundRun?: (sessionId: string) => Promise<boolean> | boolean;
  /** Optional listing helper for operator-facing durable background runs. */
  listBackgroundRuns?: (
    sessionIds: readonly string[],
  ) => Promise<readonly BackgroundRunOperatorSummary[]>;
  /** Optional capability snapshot helper for durable-run operator features. */
  getBackgroundRunAvailability?: (
    sessionId?: string,
  ) => BackgroundRunOperatorAvailability;
  /** Optional detail helper for one durable background run. */
  inspectBackgroundRun?: (
    sessionId: string,
  ) => Promise<BackgroundRunOperatorDetail | undefined>;
  /** Optional continuity helper to fork a durable run into a new session. */
  forkBackgroundRunFromCheckpoint?: (params: {
    sourceSessionId: string;
    targetSessionId: string;
    objective?: string;
  }) => Promise<boolean>;
  /** Optional mutation helper for operator-driven run controls. */
  controlBackgroundRun?: (
    params: {
      action: BackgroundRunControlAction;
      actor?: string;
      channel?: string;
    },
  ) => Promise<BackgroundRunOperatorDetail | undefined>;
  /** Optional policy simulation preview helper for operator workflows. */
  policyPreview?: (params: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }) => Promise<{
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{
        code: string;
        message: string;
      }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  }>;
  /** Optional observability summary query helper. */
  getObservabilitySummary?: (
    query?: ObservabilitySummaryQuery,
  ) => Promise<ObservabilitySummary | undefined>;
  /** Optional observability trace listing helper. */
  listObservabilityTraces?: (
    query?: ObservabilityTraceQuery,
  ) => Promise<readonly ObservabilityTraceSummary[] | undefined>;
  /** Optional observability trace detail helper. */
  getObservabilityTrace?: (
    traceId: string,
  ) => Promise<ObservabilityTraceDetail | null | undefined>;
  /** Optional observability artifact read helper. */
  getObservabilityArtifact?: (
    path: string,
  ) => Promise<ObservabilityArtifactResponse | undefined>;
  /** Optional daemon log tail helper. */
  getObservabilityLogTail?: (params: {
    readonly lines?: number;
    readonly traceId?: string;
  }) => Promise<ObservabilityLogResponse | undefined>;
  /** Shared daemon slash-command registry for first-party command catalog/execution. */
  commandRegistry?: SlashCommandRegistry;
  /** Optional session-authorized watch cockpit snapshot builder. */
  getWatchCockpitSnapshot?: (params: {
    readonly sessionId: string;
    readonly actorId: string;
    readonly channel: "webchat";
    readonly continuity: SessionContinuityRecord;
    readonly redactionProfile: "watch_cockpit";
  }) => Promise<WatchCockpitSnapshot | undefined>;
}

// ============================================================================
// WebChatChannelConfig
// ============================================================================

export interface WebChatChannelConfig {
  /** Whether the webchat channel is enabled. Default: true */
  enabled?: boolean;
}

// ============================================================================
// WebSocket Protocol — Client → Server
// ============================================================================

// ============================================================================
// WebSocket Protocol — Server → Client
// ============================================================================

// ============================================================================
// Voice WebSocket Protocol — Client → Server
// Keep in sync with web/src/types.ts voice types
// ============================================================================
