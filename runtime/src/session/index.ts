/**
 * Session subsystem — barrel export.
 *
 * @module
 */

export { Session, type SessionOpts, type SessionRunTurnOptions } from "./session.js";
export type {
  AbortReason,
  ActiveTurn,
  AgentStatus,
  Event,
  EventMsg,
  InterAgentCommunication,
  Mailbox,
  SessionServices,
  SessionState,
  ThreadId,
} from "./session.js";

export { buildTurnContext } from "./turn-context.js";
export type {
  ApprovalPolicy,
  AuthManager,
  Config,
  ModelInfo,
  SandboxPolicy,
  TurnContext,
} from "./turn-context.js";

export {
  buildInitialTurnState,
  resetIterationFields,
} from "./turn-state.js";
export type {
  AssistantMessage,
  AttachmentMessage,
  Continue,
  ContinueReason,
  Terminal,
  TerminalReason,
  ToolUseBlock,
  ToolUseSummaryMessage,
  TurnState,
  UserMessage,
} from "./turn-state.js";

export { runTurn, type RunTurnOptions } from "./run-turn.js";
export {
  ensureAgentTaskRegistered,
  maybePrewarmAgentTaskRegistration,
  cachedAgentTaskForCurrentIdentity,
  restorePersistedAgentTask,
} from "./agent-task-lifecycle.js";
export type {
  RegisteredAgentTask,
  RolloutItem,
  SessionAgentTask,
  SessionStateUpdate,
} from "./agent-task-lifecycle.js";
