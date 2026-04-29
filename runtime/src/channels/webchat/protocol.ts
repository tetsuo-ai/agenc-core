/**
 * Canonical WebChat websocket protocol schema shared by runtime + web.
 *
 * Keep message type constants and payload shapes here, then consume this
 * module from both backend and UI to avoid protocol drift.
 *
 * @module
 */

import type { SlashCommandViewKind } from "../../gateway/commands.js";
import type {
  SessionContinuityDetail,
  SessionContinuityRecord,
  SessionForkResult,
  SessionHistoryItem,
  SessionResumePayload,
} from "./types.js";
import type { SessionShellProfile } from "../../gateway/shell-profile.js";
import type { SessionWorkflowState } from "../../gateway/workflow-state.js";
import type { WorkflowOwnershipEntry } from "../../gateway/watch-cockpit.js";

// ============================================================================
// Shared constants
// ============================================================================

/** PCM 24kHz, 16-bit signed, mono, little-endian — matching xAI Realtime API format. */
export const VOICE_SAMPLE_RATE = 24_000 as const;

/** Interval (ms) between mic audio chunk flushes. */
export const VOICE_CHUNK_INTERVAL_MS = 100 as const;

// Chat
export const WS_CHAT_MESSAGE = "chat.message" as const;
export const WS_CHAT_TYPING = "chat.typing" as const;
export const WS_CHAT_HISTORY = "chat.history" as const;
export const WS_CHAT_SESSION = "chat.session" as const;
export const WS_CHAT_OWNER = "chat.owner" as const;
export const WS_CHAT_NEW = "chat.new" as const;
export const WS_CHAT_SESSION_RESUMED = "chat.session.resumed" as const;
export const WS_CHAT_SESSION_RESUME = "chat.session.resume" as const;
export const WS_CHAT_SESSION_LIST = "chat.session.list" as const;
export const WS_CHAT_SESSION_INSPECT = "chat.session.inspect" as const;
export const WS_CHAT_SESSION_FORK = "chat.session.fork" as const;
export const WS_CHAT_CANCELLED = "chat.cancelled" as const;
export const WS_CHAT_CANCEL = "chat.cancel" as const;
export const WS_CHAT_USAGE = "chat.usage" as const;

// Session command bus
export const WS_SESSION_COMMAND_CATALOG_GET =
  "session.command.catalog.get" as const;
export const WS_SESSION_COMMAND_CATALOG = "session.command.catalog" as const;
export const WS_SESSION_COMMAND_EXECUTE = "session.command.execute" as const;
export const WS_SESSION_COMMAND_RESULT = "session.command.result" as const;

// Watch cockpit
export const WS_WATCH_COCKPIT_GET = "watch.cockpit.get" as const;
export const WS_WATCH_COCKPIT = "watch.cockpit" as const;

// Events
export const WS_EVENTS_SUBSCRIBE = "events.subscribe" as const;
export const WS_EVENTS_UNSUBSCRIBE = "events.unsubscribe" as const;
export const WS_EVENTS_SUBSCRIBED = "events.subscribed" as const;
export const WS_EVENTS_UNSUBSCRIBED = "events.unsubscribed" as const;
export const WS_EVENTS_EVENT = "events.event" as const;

// Subagent lifecycle
export const WS_SUBAGENTS_PLANNED = "subagents.planned" as const;
const WS_SUBAGENTS_POLICY_BYPASSED = "subagents.policy_bypassed" as const;
export const WS_SUBAGENTS_SPAWNED = "subagents.spawned" as const;
export const WS_SUBAGENTS_STARTED = "subagents.started" as const;
export const WS_SUBAGENTS_PROGRESS = "subagents.progress" as const;
export const WS_SUBAGENTS_TOOL_EXECUTING = "subagents.tool.executing" as const;
export const WS_SUBAGENTS_TOOL_RESULT = "subagents.tool.result" as const;
export const WS_SUBAGENTS_COMPLETED = "subagents.completed" as const;
export const WS_SUBAGENTS_FAILED = "subagents.failed" as const;
export const WS_SUBAGENTS_CANCELLED = "subagents.cancelled" as const;
export const WS_SUBAGENTS_SYNTHESIZED = "subagents.synthesized" as const;

// Tools
export const WS_TOOLS_EXECUTING = "tools.executing" as const;
export const WS_TOOLS_RESULT = "tools.result" as const;

// Voice
export const WS_VOICE_START = "voice.start" as const;
export const WS_VOICE_STOP = "voice.stop" as const;
export const WS_VOICE_AUDIO = "voice.audio" as const;
export const WS_VOICE_COMMIT = "voice.commit" as const;
export const WS_VOICE_STARTED = "voice.started" as const;
export const WS_VOICE_STOPPED = "voice.stopped" as const;
export const WS_VOICE_TRANSCRIPT = "voice.transcript" as const;
export const WS_VOICE_USER_TRANSCRIPT = "voice.user_transcript" as const;
export const WS_VOICE_SPEECH_STARTED = "voice.speech_started" as const;
export const WS_VOICE_SPEECH_STOPPED = "voice.speech_stopped" as const;
export const WS_VOICE_RESPONSE_DONE = "voice.response_done" as const;
export const WS_VOICE_DELEGATION = "voice.delegation" as const;
export const WS_VOICE_STATE = "voice.state" as const;
export const WS_VOICE_ERROR = "voice.error" as const;

// Desktop
export const WS_DESKTOP_LIST = "desktop.list" as const;
export const WS_DESKTOP_CREATE = "desktop.create" as const;
export const WS_DESKTOP_CREATED = "desktop.created" as const;
export const WS_DESKTOP_ATTACH = "desktop.attach" as const;
export const WS_DESKTOP_ATTACHED = "desktop.attached" as const;
export const WS_DESKTOP_DESTROY = "desktop.destroy" as const;
export const WS_DESKTOP_DESTROYED = "desktop.destroyed" as const;
export const WS_DESKTOP_ERROR = "desktop.error" as const;

// Durable runs
export const WS_RUNS_LIST = "runs.list" as const;
export const WS_RUN_INSPECT = "run.inspect" as const;
export const WS_RUN_CONTROL = "run.control" as const;
export const WS_RUN_UPDATED = "run.updated" as const;

// Observability
export const WS_OBSERVABILITY_SUMMARY = "observability.summary" as const;
export const WS_OBSERVABILITY_TRACES = "observability.traces" as const;
export const WS_OBSERVABILITY_TRACE = "observability.trace" as const;
export const WS_OBSERVABILITY_ARTIFACT = "observability.artifact" as const;
export const WS_OBSERVABILITY_LOGS = "observability.logs" as const;

// Approval
export const WS_APPROVAL_REQUEST = "approval.request" as const;

// Agent status
export const WS_AGENT_STATUS = "agent.status" as const;

// ============================================================================
// Shared payload shapes (drift-prone messages first)
// ============================================================================

export interface SocialMessagePayload {
  messageId: string;
  sender: string;
  recipient: string;
  content: string;
  mode: string;
  timestamp: number;
  onChain: boolean;
  threadId?: string | null;
}

export const WS_SUBAGENT_LIFECYCLE_TYPES = [
  WS_SUBAGENTS_PLANNED,
  WS_SUBAGENTS_POLICY_BYPASSED,
  WS_SUBAGENTS_SPAWNED,
  WS_SUBAGENTS_STARTED,
  WS_SUBAGENTS_PROGRESS,
  WS_SUBAGENTS_TOOL_EXECUTING,
  WS_SUBAGENTS_TOOL_RESULT,
  WS_SUBAGENTS_COMPLETED,
  WS_SUBAGENTS_FAILED,
  WS_SUBAGENTS_CANCELLED,
  WS_SUBAGENTS_SYNTHESIZED,
] as const;

export type SubagentLifecycleType = (typeof WS_SUBAGENT_LIFECYCLE_TYPES)[number];

export interface SubagentLifecyclePayload {
  sessionId: string;
  parentSessionId?: string;
  subagentSessionId?: string;
  toolName?: string;
  timestamp: number;
  data?: Record<string, unknown>;
  traceId?: string;
  parentTraceId?: string;
}

export interface SessionCommandExecutePayload {
  readonly content: string;
  readonly sessionId?: string;
  readonly client?: "shell" | "console" | "web";
}

export interface SessionCommandCurrentSessionData {
  readonly sessionId: string;
  readonly runtimeSessionId: string;
  readonly shellProfile: SessionShellProfile;
  readonly workflowState: SessionWorkflowState;
  readonly workspaceRoot: string;
  readonly historyMessages: number;
  readonly model?: string;
  readonly ownership?: readonly WorkflowOwnershipEntry[];
}

export interface SessionCommandData {
  readonly kind: "session";
  readonly subcommand: string;
  readonly currentSession?: SessionCommandCurrentSessionData;
  readonly sessions?: readonly SessionContinuityRecord[];
  readonly detail?: SessionContinuityDetail;
  readonly history?: readonly SessionHistoryItem[];
  readonly resumed?: {
    readonly sessionId: SessionResumePayload["sessionId"];
    readonly messageCount: SessionResumePayload["messageCount"];
    readonly workspaceRoot?: SessionResumePayload["workspaceRoot"];
  };
  readonly forked?: {
    readonly sourceSessionId: SessionForkResult["sourceSessionId"];
    readonly targetSessionId: SessionForkResult["targetSessionId"];
    readonly forkSource?: SessionForkResult["forkSource"];
    readonly session?: SessionContinuityRecord;
  };
}

export interface WorkflowCommandData {
  readonly kind: "workflow";
  readonly subcommand: string;
  readonly shellProfile: SessionShellProfile;
  readonly workflowState: SessionWorkflowState;
  readonly plannerStatus: string;
  readonly suggestedNextStage?: SessionWorkflowState["stage"];
  readonly branchInfo?: Record<string, unknown>;
  readonly changeSummary?: Record<string, unknown>;
  readonly tasks?: Record<string, unknown>;
  readonly ownership?: readonly WorkflowOwnershipEntry[];
  readonly delegated?: {
    readonly sessionId: string;
    readonly status: string;
    readonly output?: string;
  };
}

export interface AgentsCommandData {
  readonly kind: "agents";
  readonly subcommand: string;
  readonly roles?: readonly Record<string, unknown>[];
  readonly entries?: readonly Record<string, unknown>[];
  readonly detail?: Record<string, unknown>;
  readonly launched?: Record<string, unknown>;
  readonly stopped?: Record<string, unknown>;
}

export interface GitCommandData {
  readonly kind: "git";
  readonly subcommand: string;
  readonly branchInfo?: Record<string, unknown>;
  readonly changeSummary?: Record<string, unknown>;
  readonly diff?: Record<string, unknown>;
}

export interface DiffCommandData {
  readonly kind: "diff";
  readonly subcommand: string;
  readonly branchInfo?: Record<string, unknown>;
  readonly changeSummary?: Record<string, unknown>;
  readonly diff?: Record<string, unknown>;
}

export interface FilesCommandData {
  readonly kind: "files";
  readonly mode: "inventory" | "search";
  readonly query?: string;
  readonly result?: Record<string, unknown>;
}

export interface GrepCommandData {
  readonly kind: "grep";
  readonly pattern: string;
  readonly result?: Record<string, unknown>;
}

export interface TasksCommandData {
  readonly kind: "tasks";
  readonly subcommand: string;
  readonly taskId?: string;
  readonly result?: Record<string, unknown>;
}

export interface PolicyCommandData {
  readonly kind: "policy";
  readonly subcommand: string;
  readonly sessionPolicyState?: {
    readonly elevatedPatterns: readonly string[];
    readonly deniedPatterns: readonly string[];
  };
  readonly leases?: readonly Record<string, unknown>[];
  readonly preview?: Record<string, unknown>;
}

export interface ExtensionsCommandData {
  readonly kind: "extensions";
  readonly surface: "mcp" | "skills" | "plugin";
  readonly subcommand: string;
  readonly target?: string;
  readonly entries?: readonly Record<string, unknown>[];
  readonly detail?: Record<string, unknown>;
  readonly status?: Record<string, unknown>;
}

export interface RuntimeCommandMetric {
  readonly label: string;
  readonly value: string;
  readonly tone?: "neutral" | "success" | "warning" | "danger";
}

export interface RuntimeCommandSection {
  readonly title: string;
  readonly body?: string;
  readonly items?: readonly string[];
}

export interface RuntimeCommandData {
  readonly kind: "runtime";
  readonly surface:
    | "context"
    | "status"
    | "profile"
    | "model"
    | "effort"
    | "voice"
    | "memory";
  readonly status?: string;
  readonly metrics?: readonly RuntimeCommandMetric[];
  readonly sections?: readonly RuntimeCommandSection[];
  readonly detail?: Record<string, unknown>;
}

export interface ReviewCommandData {
  readonly kind: "review";
  readonly mode: "default" | "security" | "pr-comments";
  readonly delegated: boolean;
  readonly branchInfo?: Record<string, unknown>;
  readonly changeSummary?: Record<string, unknown>;
  readonly diff?: Record<string, unknown>;
  readonly reviewSurface?: {
    readonly status: string;
    readonly source: string;
    readonly delegatedSessionId?: string;
    readonly summaryPreview?: string;
  };
  readonly delegatedResult?: {
    readonly sessionId: string;
    readonly status: string;
    readonly output?: string;
  };
}

export interface VerifyCommandData {
  readonly kind: "verify";
  readonly delegated: boolean;
  readonly branchInfo?: Record<string, unknown>;
  readonly changeSummary?: Record<string, unknown>;
  readonly tasks?: Record<string, unknown>;
  readonly runtimeStatusSnapshot?: Record<string, unknown>;
  readonly verificationSurface?: {
    readonly status: string;
    readonly source: string;
    readonly delegatedSessionId?: string;
    readonly summaryPreview?: string;
    readonly verdict?: string;
  };
  readonly delegatedResult?: {
    readonly sessionId: string;
    readonly status: string;
    readonly output?: string;
  };
}

export type SessionCommandResultData =
  | SessionCommandData
  | WorkflowCommandData
  | AgentsCommandData
  | GitCommandData
  | DiffCommandData
  | FilesCommandData
  | GrepCommandData
  | TasksCommandData
  | PolicyCommandData
  | ExtensionsCommandData
  | RuntimeCommandData
  | ReviewCommandData
  | VerifyCommandData;

export interface SessionCommandResultPayload {
  readonly commandName: string;
  readonly content: string;
  readonly sessionId?: string;
  readonly client?: "shell" | "console" | "web";
  readonly viewKind?: SlashCommandViewKind;
  readonly data?: SessionCommandResultData;
}

type WebChatFilterList = readonly string[] | null;

export function matchesEventFilters(
  eventType: string,
  filters: WebChatFilterList,
): boolean {
  if (!filters || filters.length === 0) return true;
  for (const filter of filters) {
    if (filter === "*" || filter === eventType) return true;
    if (filter.endsWith("*")) {
      const prefix = filter.slice(0, -1);
      if (eventType.startsWith(prefix)) return true;
    }
    if (eventType.startsWith(`${filter}.`)) return true;
  }
  return false;
}
