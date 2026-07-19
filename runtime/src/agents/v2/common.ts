import { randomUUID } from "node:crypto";
import type { AgentControl } from "../control.js";
import {
  ROOT_AGENT_PATH,
  type AgentPath,
  type AgentRegistry,
  type ThreadId,
} from "../registry.js";
import { formatAgentRoleLabel } from "../role-presentation.js";
import {
  toAgentStatusJson,
  type AgentStatus,
} from "../status.js";
import { SESSION_ID_ARG } from "../_deps/filesystem-args.js";
import type { Session } from "../../session/session.js";
import type { AgentRoleWorkspace } from "../role.js";
import type {
  Tool,
  ToolAdmissionEstimate,
  ToolResult,
} from "../../tools/types.js";
import { safeStringify } from "../../tools/types.js";

export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;

const LOCAL_ZERO_ADMISSION_ESTIMATE = Object.freeze({
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCostUsd: 0,
}) satisfies ToolAdmissionEstimate;

/** Collaboration control is local; nested spawn/model work admits separately. */
export function localZeroAdmissionEstimate(): ToolAdmissionEstimate {
  return LOCAL_ZERO_ADMISSION_ESTIMATE;
}

export interface MultiAgentV2Options {
  readonly getSession: () => Session | null;
  readonly workspace: AgentRoleWorkspace;
  readonly ensureAgentControl: (session: Session) => {
    readonly control: AgentControl;
    readonly registry: AgentRegistry;
  };
}

export interface CurrentAgentContext {
  readonly threadId: ThreadId;
  readonly agentPath: AgentPath;
  readonly agentNickname?: string;
  readonly agentRole?: string;
}

export function json(content: unknown, isError?: boolean): ToolResult {
  return {
    content: safeStringify(content),
    ...(isError ? { isError: true } : {}),
  };
}

export function toolMetadata(
  family: string,
  opts: {
    readonly mutating?: boolean;
    readonly deferred?: boolean;
    readonly hiddenByDefault?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family,
    source: "builtin",
    hiddenByDefault: opts.hiddenByDefault ?? false,
    mutating: opts.mutating ?? false,
    deferred: opts.deferred ?? false,
    keywords: opts.keywords ?? [family],
    preferredProfiles: ["coding", "operator", "general"],
  };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function callIdFromArgs(
  args: Record<string, unknown>,
  prefix: string,
): string {
  return stringValue(args.__callId) ?? `${prefix}-${randomUUID()}`;
}

export function strictArgs(
  args: Record<string, unknown>,
  opts: {
    readonly allowed: ReadonlySet<string>;
    readonly required?: ReadonlyArray<string>;
  },
): ToolResult | null {
  const allowed = new Set<string>([
    ...opts.allowed,
    "__callId",
    SESSION_ID_ARG,
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return json({ error: `unknown field \`${key}\`` }, true);
    }
  }
  for (const key of opts.required ?? []) {
    const value = args[key];
    if (typeof value !== "string") {
      return json({ error: `${key} is required` }, true);
    }
  }
  return null;
}

export function getSessionOrError(
  opts: MultiAgentV2Options,
): Session | ToolResult {
  const session = opts.getSession();
  if (session === null) {
    return json({ error: "tool invoked before session was initialized" }, true);
  }
  return session;
}

export function emit(
  session: Session,
  msg: Parameters<Session["emit"]>[0]["msg"],
): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg,
  });
}

export function currentAgentContext(
  session: Session,
  args: Record<string, unknown>,
  opts: MultiAgentV2Options,
): CurrentAgentContext {
  const { control } = opts.ensureAgentControl(session);
  const injectedSessionId = stringValue(args[SESSION_ID_ARG]);
  if (injectedSessionId) {
    const live = control.getLive(injectedSessionId);
    if (live) {
      return {
        threadId: live.agentId,
        agentPath: live.agentPath,
        agentNickname: live.nickname,
        agentRole: live.role.name,
      };
    }
  }
  return {
    threadId: session.conversationId,
    agentPath: ROOT_AGENT_PATH,
  };
}

export function resolveAgentId(
  session: Session,
  target: string,
  currentAgentPath: AgentPath,
  opts: MultiAgentV2Options,
): ThreadId {
  const { control } = opts.ensureAgentControl(session);
  control.registerSessionRoot(session.conversationId);
  if (target === session.conversationId) return target;
  if (control.getLive(target)) return target;
  return control.resolveAgentReference({
    currentAgentPath,
    reference: target,
  });
}

export function receiverMetadataFor(
  session: Session,
  receiverThreadId: ThreadId,
  opts: MultiAgentV2Options,
): {
  readonly receiverAgentNickname?: string;
  readonly receiverAgentRole?: string;
  readonly receiverAgentRoleDisplayName?: string;
} {
  const { control } = opts.ensureAgentControl(session);
  const live = control.getLive(receiverThreadId);
  const metadata = control.getAgentMetadata(receiverThreadId) ?? live?.metadata;
  const roleName = metadata?.agentRole ?? live?.role.name;
  return {
    ...(metadata?.agentNickname !== undefined
      ? { receiverAgentNickname: metadata.agentNickname }
      : live?.nickname !== undefined
        ? { receiverAgentNickname: live.nickname }
        : {}),
    ...(roleName !== undefined ? { receiverAgentRole: roleName } : {}),
    ...(roleName !== undefined
      ? { receiverAgentRoleDisplayName: formatAgentRoleLabel(roleName) }
      : {}),
  };
}

export function hideSpawnAgentMetadata(session: Session): boolean {
  return (
    (
      session.config as {
        multiAgentV2?: { hideSpawnAgentMetadata?: boolean };
      }
    )?.multiAgentV2?.hideSpawnAgentMetadata === true
  );
}

export function toListedAgentJson(agent: {
  readonly agentName: string;
  readonly agentStatus: AgentStatus;
  readonly lastTaskMessage?: string;
}): {
  readonly agent_name: string;
  readonly agent_status: ReturnType<typeof toAgentStatusJson>;
  readonly last_task_message?: string;
} {
  return {
    agent_name: agent.agentName,
    agent_status: toAgentStatusJson(agent.agentStatus),
    ...(agent.lastTaskMessage !== undefined
      ? { last_task_message: agent.lastTaskMessage }
      : {}),
  };
}
