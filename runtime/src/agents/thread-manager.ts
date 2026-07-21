import { readFileSync } from "node:fs";
import type { LLMContentPart } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { ResponseItem, RolloutItem } from "../session/rollout-item.js";
import { parseRolloutLine } from "../session/rollout-item.js";
import { responseItemToLlmMessage as responseItemToLlmHistoryMessage } from "../session/message-history-conversion.js";
import { threadConfigSnapshot } from "../session/turn-context.js";
import type { InterAgentCommunication } from "./mailbox.js";
import type { AgentStatus } from "./status.js";
import { BehaviorSubject } from "./_deps/behavior-subject.js";
import type { AgentPath, AgentRegistry, ThreadId } from "./registry.js";
import type { AgentControl, LiveAgent } from "./control.js";
import {
  forkSnapshotRollout,
  type ForkSnapshot,
} from "./thread-rollout-truncation.js";

export type ThreadManagerOp =
  | {
      readonly type: "user_input";
      readonly input: string | readonly LLMContentPart[];
    }
  | {
      readonly type: "inter_agent_communication";
      readonly communication: Omit<InterAgentCommunication, "seq" | "direction">;
    }
  | { readonly type: "clear_conversation_history" }
  | { readonly type: "append_message"; readonly message: string }
  | { readonly type: "interrupt"; readonly reason?: string }
  | { readonly type: "shutdown"; readonly reason?: string }
  | { readonly type: "refresh_mcp_servers"; readonly config: unknown };

export interface ManagedThread {
  readonly threadId: ThreadId;
  readonly agentPath?: AgentPath;
  readonly parentThreadId?: ThreadId;
  readonly kind: "root" | "agent";
  status(): AgentStatus;
  subscribeStatus(listener: (status: AgentStatus) => void): () => void;
  submit(op: ThreadManagerOp): Promise<string>;
  appendMessage(message: string): Promise<string>;
  shutdown(reason?: string): Promise<void>;
  totalTokenUsage?(): unknown;
  conversationHistoryLength?(): number;
  replaceConversationHistory?(history: ReadonlyArray<ResponseItem>): void;
  configSnapshot?(): Record<string, unknown> | undefined;
  rolloutPath?(): string | undefined;
  ensureRolloutMaterialized?(): Promise<void> | void;
  flushRollout?(): Promise<void> | void;
}

export interface ThreadShutdownReport {
  readonly completed: ThreadId[];
  readonly submitFailed: ThreadId[];
  readonly timedOut: ThreadId[];
}

type ThreadCreatedListener = (threadId: ThreadId) => void;
const ROOT_THREAD_AGENT_PATH = "/root" as AgentPath;

type SessionAgentStatus = Session["agentStatus"]["value"];

function normalizeSessionStatus(status: SessionAgentStatus): AgentStatus {
  switch (status.status) {
    case "completed":
      return {
        status: "completed",
        turnId: status.turnId,
        endedAtMs: status.endedAtMs,
      };
    case "errored":
      return {
        status: "errored",
        turnId: status.turnId,
        error: status.error,
        endedAtMs: Date.now(),
      };
    case "shutdown":
      return { status: "shutdown", endedAtMs: Date.now() };
    case "interrupted":
      return {
        status: "interrupted",
        turnId: status.turnId,
        reason: "interrupted",
        endedAtMs: Date.now(),
      };
    case "running":
      return status;
    case "idle":
      return status;
    case "pending_init":
      return status;
    case "not_found":
      return status;
  }
}

export interface ThreadManagerOpts {
  readonly rootSession?: Session;
  readonly control?: AgentControl;
  readonly registry?: AgentRegistry;
}

export interface NewManagedThread {
  readonly threadId: ThreadId;
  readonly thread: ManagedThread;
  readonly sessionConfigured?: unknown;
}

export type SpawnManagedLiveAgentOptions = Parameters<AgentControl["spawn"]>[0];

export interface ThreadOperationManager {
  bindAgentControl(control: AgentControl): void;
  spawnLiveAgent(opts: SpawnManagedLiveAgentOptions): Promise<LiveAgent>;
  hasThread(threadId: ThreadId): boolean;
  sendOp(threadId: ThreadId, op: ThreadManagerOp): Promise<string>;
  appendMessage(threadId: ThreadId, message: string): Promise<string>;
  removeThread(threadId: ThreadId): ManagedThread | undefined;
  registerLiveAgent(
    live: LiveAgent,
    opts?: { readonly parentThreadId?: ThreadId },
  ): ManagedThread;
  getThread(threadId: ThreadId): ManagedThread;
}

class ThreadNotManagedError extends Error {
  constructor(threadId: ThreadId) {
    super(`thread not found: ${threadId}`);
    this.name = "ThreadNotManagedError";
  }
}

export class AgenCThread implements ManagedThread {
  readonly threadId: ThreadId;
  readonly agentPath?: AgentPath;
  readonly parentThreadId?: ThreadId;
  readonly kind: "root" | "agent";
  private readonly session?: Session;
  private readonly live?: LiveAgent;
  private readonly statusSubject: BehaviorSubject<AgentStatus>;

  constructor(opts: {
    readonly threadId: ThreadId;
    readonly kind: "root" | "agent";
    readonly agentPath?: AgentPath;
    readonly parentThreadId?: ThreadId;
    readonly session?: Session;
    readonly live?: LiveAgent;
  }) {
    this.threadId = opts.threadId;
    this.kind = opts.kind;
    if (opts.agentPath !== undefined) this.agentPath = opts.agentPath;
    if (opts.parentThreadId !== undefined) this.parentThreadId = opts.parentThreadId;
    if (opts.session !== undefined) this.session = opts.session;
    if (opts.live !== undefined) this.live = opts.live;
    this.statusSubject = new BehaviorSubject<AgentStatus>(this.readStatus());
    opts.live?.status.subscribe((status) => this.statusSubject.next(status));
    opts.session?.agentStatus?.subscribe?.((status) => {
      this.statusSubject.next(normalizeSessionStatus(status));
    });
  }

  status(): AgentStatus {
    return this.readStatus();
  }

  subscribeStatus(listener: (status: AgentStatus) => void): () => void {
    return this.statusSubject.subscribe(listener);
  }

  async submit(op: ThreadManagerOp): Promise<string> {
    if (this.session) return submitToSession(this.session, op);
    if (this.live) return submitToLiveAgent(this.live, op);
    return this.threadId;
  }

  async appendMessage(message: string): Promise<string> {
    return this.submit({ type: "append_message", message });
  }

  async shutdown(reason?: string): Promise<void> {
    await this.submit({ type: "shutdown", reason: reason ?? "shutdown" });
    this.statusSubject.complete();
  }

  totalTokenUsage(): unknown {
    if (this.session) {
      return this.session.state?.unsafePeek?.().totalTokenUsage;
    }
    return this.live?.tokenUsage;
  }

  conversationHistoryLength(): number {
    if (this.session) {
      return this.session.state?.unsafePeek?.().history?.length ?? 0;
    }
    return this.live?.messages.length ?? 0;
  }

  replaceConversationHistory(history: ReadonlyArray<ResponseItem>): void {
    if (!this.live) return;
    this.live.messages.splice(
      0,
      this.live.messages.length,
      ...history.map(responseItemToLlmHistoryMessage),
    );
  }

  sourceSession(): Session | undefined {
    return this.session;
  }

  configSnapshot(): Record<string, unknown> | undefined {
    if (this.session) {
      return threadConfigSnapshot(
        this.session.sessionConfiguration,
      ) as unknown as Record<string, unknown>;
    }
    return this.live?.configSnapshot;
  }

  rolloutPath(): string | undefined {
    return this.session?.rolloutStore?.rolloutPath ?? this.live?.rolloutPath;
  }

  async ensureRolloutMaterialized(): Promise<void> {
    this.session?.rolloutStore?.flushDurable();
  }

  async flushRollout(): Promise<void> {
    this.session?.rolloutStore?.flushDurable();
  }

  private readStatus(): AgentStatus {
    if (this.session?.agentStatus?.value) {
      return normalizeSessionStatus(this.session.agentStatus.value);
    }
    if (this.live) return this.live.status.value as AgentStatus;
    return { status: "not_found" };
  }
}

export class ThreadManagerState {
  readonly threads = new Map<ThreadId, ManagedThread>();
  readonly createdListeners = new Set<ThreadCreatedListener>();
  control: AgentControl | undefined;
  registry: AgentRegistry | undefined;

  constructor(opts: {
    readonly control?: AgentControl;
    readonly registry?: AgentRegistry;
  } = {}) {
    this.control = opts.control;
    this.registry = opts.registry;
  }

  listThreadIds(): ThreadId[] {
    return Array.from(this.threads.keys());
  }

  getThread(threadId: ThreadId): ManagedThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ThreadNotManagedError(threadId);
    return thread;
  }

  setThread(thread: ManagedThread): void {
    const existed = this.threads.has(thread.threadId);
    this.threads.set(thread.threadId, thread);
    if (existed) return;
    for (const listener of this.createdListeners) {
      listener(thread.threadId);
    }
  }

  async sendOp(threadId: ThreadId, op: ThreadManagerOp): Promise<string> {
    return this.getThread(threadId).submit(op);
  }

  async appendMessage(threadId: ThreadId, message: string): Promise<string> {
    return this.getThread(threadId).appendMessage(message);
  }

  removeThread(threadId: ThreadId): ManagedThread | undefined {
    const thread = this.threads.get(threadId);
    this.threads.delete(threadId);
    return thread;
  }

  notifyThreadCreated(threadId: ThreadId): void {
    for (const listener of this.createdListeners) {
      listener(threadId);
    }
  }
}

export class ThreadManager implements ThreadOperationManager {
  readonly state: ThreadManagerState;

  constructor(rootOrOpts?: Session | ThreadManagerOpts) {
    const opts =
      rootOrOpts && "conversationId" in rootOrOpts
        ? { rootSession: rootOrOpts }
        : (rootOrOpts ?? {});
    this.state = new ThreadManagerState({
      control: opts.control,
      registry: opts.registry,
    });
    if (opts.rootSession) this.registerRootSession(opts.rootSession);
  }

  bindAgentControl(control: AgentControl): void {
    this.state.control = control;
  }

  bindRegistry(registry: AgentRegistry): void {
    this.state.registry = registry;
  }

  registerRootSession(session: Session): ManagedThread {
    const thread = new AgenCThread({
      threadId: session.conversationId,
      agentPath: ROOT_THREAD_AGENT_PATH,
      kind: "root",
      session,
    });
    if (
      typeof this.state.registry?.registerRootThread === "function" &&
      typeof session.conversationId === "string"
    ) {
      this.state.registry.registerRootThread(session.conversationId);
    }
    this.state.setThread(thread);
    return thread;
  }

  async startThread(session: Session): Promise<NewManagedThread> {
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async startThreadWithTools(session: Session): Promise<NewManagedThread> {
    return this.startThread(session);
  }

  async startThreadWithToolsAndServiceName(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.startThread(session);
  }

  async resumeThreadWithHistory(session: Session): Promise<NewManagedThread> {
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async resumeThreadFromRollout(session: Session): Promise<NewManagedThread> {
    return this.resumeThreadWithHistory(session);
  }

  async resumeThreadFromRolloutWithSource(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.resumeThreadWithHistory(session);
  }

  async forkThread(
    session: Session,
    snapshot: ForkSnapshot = { kind: "interrupted" },
  ): Promise<NewManagedThread> {
    const rollout = session.rolloutStore?.readAll() ?? [];
    const forkedHistory = forkSnapshotRollout(rollout, snapshot);
    void forkedHistory;
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async forkThreadWithSource(
    session: Session,
    snapshot: ForkSnapshot = { kind: "interrupted" },
  ): Promise<NewManagedThread> {
    return this.forkThread(session, snapshot);
  }

  async spawnNewThreadWithSource(
    opts: SpawnManagedLiveAgentOptions,
  ): Promise<NewManagedThread> {
    return this.spawnThreadWithSource(opts);
  }

  async spawnThreadWithSource(
    opts: SpawnManagedLiveAgentOptions,
  ): Promise<NewManagedThread> {
    const live = await this.spawnLiveAgent(opts);
    const thread = this.getThread(live.agentId);
    return { threadId: live.agentId, thread };
  }

  async finalizeThreadSpawn(thread: ManagedThread): Promise<NewManagedThread> {
    this.state.setThread(thread);
    return { threadId: thread.threadId, thread };
  }

  async spawnLiveAgent(
    opts: SpawnManagedLiveAgentOptions,
  ): Promise<LiveAgent> {
    if (!this.state.control) {
      throw new Error("ThreadManager cannot spawn an agent before AgentControl is bound");
    }
    const live = await this.state.control.spawnLiveAgentForThreadManager(opts);
    const parentThreadId =
      typeof this.state.registry?.agentIdForPath === "function"
        ? this.state.registry.agentIdForPath(opts.parentPath)
        : undefined;
    this.registerLiveAgent(live, {
      ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    });
    return live;
  }

  registerLiveAgent(
    live: LiveAgent,
    opts: { readonly parentThreadId?: ThreadId } = {},
  ): ManagedThread {
    const thread = new AgenCThread({
      threadId: live.agentId,
      agentPath: live.agentPath,
      kind: "agent",
      live,
      ...(opts.parentThreadId !== undefined
        ? { parentThreadId: opts.parentThreadId }
        : {}),
    });
    this.state.setThread(thread);
    return thread;
  }

  getThread(threadId: ThreadId): ManagedThread {
    return this.state.getThread(threadId);
  }

  hasThread(threadId: ThreadId): boolean {
    return this.state.threads.has(threadId);
  }

  listThreadIds(): readonly ThreadId[] {
    return this.state.listThreadIds();
  }

  removeThread(threadId: ThreadId): ManagedThread | undefined {
    return this.state.removeThread(threadId);
  }

  async sendOp(threadId: ThreadId, op: ThreadManagerOp): Promise<string> {
    return this.state.sendOp(threadId, op);
  }

  async appendMessage(threadId: ThreadId, message: string): Promise<string> {
    return this.state.appendMessage(threadId, message);
  }

  async refreshMcpServers(config: unknown): Promise<void> {
    await Promise.all(
      Array.from(this.state.threads.values()).map(async (thread) => {
        try {
          await thread.submit({ type: "refresh_mcp_servers", config });
        } catch {
          /* refresh is best-effort across the managed tree */
        }
      }),
    );
  }

  async shutdownAllThreadsBounded(timeoutMs: number): Promise<ThreadShutdownReport> {
    const entries = Array.from(this.state.threads.entries());
    const report: ThreadShutdownReport = {
      completed: [],
      submitFailed: [],
      timedOut: [],
    };
    await Promise.all(
      entries.map(async ([threadId, thread]) => {
        const outcome = await shutdownWithTimeout(thread, timeoutMs);
        report[outcome].push(threadId);
      }),
    );
    for (const threadId of report.completed) {
      this.state.threads.delete(threadId);
    }
    report.completed.sort();
    report.submitFailed.sort();
    report.timedOut.sort();
    return report;
  }

  subscribeThreadCreated(listener: ThreadCreatedListener): () => void {
    this.state.createdListeners.add(listener);
    return () => {
      this.state.createdListeners.delete(listener);
    };
  }

  listAgentSubtreeThreadIds(rootThreadId: ThreadId): readonly ThreadId[] {
    const result: ThreadId[] = [];
    const seen = new Set<ThreadId>();
    const push = (threadId: ThreadId): void => {
      if (seen.has(threadId)) return;
      seen.add(threadId);
      result.push(threadId);
    };
    push(rootThreadId);

    const session = Array.from(this.state.threads.values())
      .map((thread) =>
        thread instanceof AgenCThread ? thread.sourceSession() : undefined,
      )
      .find((candidate): candidate is Session => candidate !== undefined);
    const rollout = session?.rolloutStore;
    if (rollout) {
      for (const status of ["open", "closed"] as const) {
        for (const edge of rollout.listThreadSpawnDescendantsWithStatus(
          rootThreadId,
          status,
        )) {
          push(edge.childThreadId);
        }
      }
    }

    const byParent = new Map<ThreadId, ThreadId[]>();
    for (const thread of this.state.threads.values()) {
      if (!thread.parentThreadId) continue;
      const bucket = byParent.get(thread.parentThreadId) ?? [];
      bucket.push(thread.threadId);
      byParent.set(thread.parentThreadId, bucket);
    }
    for (const bucket of byParent.values()) bucket.sort();
    const queue = [...(byParent.get(rootThreadId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      push(next);
      queue.push(...(byParent.get(next) ?? []));
    }
    return result;
  }
}

async function submitToSession(
  session: Session,
  op: ThreadManagerOp,
): Promise<string> {
  switch (op.type) {
    case "user_input":
      await session.submit(op.input);
      return session.conversationId;
    case "clear_conversation_history":
      await session.state.with((state) => {
        state.history.length = 0;
      });
      session.clearProviderResponseId();
      return session.conversationId;
    case "inter_agent_communication":
      session.mailbox.send({
        ...op.communication,
        direction: "up",
        metadata: { kind: "inter_agent_communication" },
      });
      if (op.communication.triggerTurn) {
        await session.submit("", { displayUserMessage: null });
      }
      return session.conversationId;
    case "append_message":
      session.mailbox.send({
        author: ROOT_THREAD_AGENT_PATH,
        recipient: ROOT_THREAD_AGENT_PATH,
        content: op.message,
        triggerTurn: false,
        direction: "up",
        metadata: { kind: "append_message" },
      });
      return session.conversationId;
    case "interrupt":
      await session.abortAllTasks("interrupted");
      return session.conversationId;
    case "shutdown":
      await session.shutdown();
      return session.conversationId;
    case "refresh_mcp_servers":
      await session.services.mcpManager.refreshFromConfig?.(op.config);
      return session.conversationId;
  }
}

async function submitToLiveAgent(
  live: LiveAgent,
  op: ThreadManagerOp,
): Promise<string> {
  switch (op.type) {
    case "user_input":
      {
        const content = userInputDisplayText(op.input);
        live.downInbox.send({
          author: live.agentPath,
          recipient: live.agentPath,
          content,
          triggerTurn: true,
          direction: "down",
          metadata: { kind: "user_input", inputContent: op.input },
        });
      }
      return live.agentId;
    case "clear_conversation_history":
      live.messages.length = 0;
      live.downInbox.send({
        author: live.agentPath,
        recipient: live.agentPath,
        content: "",
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "history_clear" },
      });
      return live.agentId;
    case "inter_agent_communication":
      live.downInbox.send({
        ...op.communication,
        direction: "down",
        metadata: { kind: "inter_agent_communication" },
      });
      return live.agentId;
    case "append_message":
      live.downInbox.send({
        author: live.agentPath,
        recipient: live.agentPath,
        content: op.message,
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "append_message" },
      });
      return live.agentId;
    case "interrupt":
      if (!live.abortController.signal.aborted) {
        live.abortController.abort(op.reason ?? "interrupt");
      }
      live.status.markInterrupted(live.agentId, op.reason ?? "interrupt");
      return live.agentId;
    case "shutdown":
      const reason = op.reason ?? "shutdown";
      live.upInbox.close(reason);
      live.downInbox.close(reason);
      live.status.markShutdown();
      live.status.complete();
      if (!live.abortController.signal.aborted) {
        live.abortController.abort(reason);
      }
      return live.agentId;
    case "refresh_mcp_servers":
      // Route the refresh to the child's run loop, which applies it to the
      // child session's MCP manager between turns (drainChildMailbox /
      // run-agent). Previously this was a silent no-op, leaving live
      // subagents on stale MCP config.
      live.downInbox.send({
        author: live.agentPath,
        recipient: live.agentPath,
        content: "",
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "mcp_refresh", mcpConfig: op.config },
      });
      return live.agentId;
  }
}

function userInputDisplayText(input: string | readonly LLMContentPart[]): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => {
      if (part.type === "text") return part.text;
      return "[image]";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

async function shutdownWithTimeout(
  thread: ManagedThread,
  timeoutMs: number,
): Promise<keyof ThreadShutdownReport> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      thread.shutdown("thread_manager_shutdown"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("shutdown timed out"));
        }, Math.max(0, timeoutMs));
      }),
    ]);
    return "completed";
  } catch (error) {
    if (error instanceof Error && error.message === "shutdown timed out") {
      return "timedOut";
    }
    return "submitFailed";
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function readRolloutHistory(path: string): RolloutItem[] {
  let corruptLines = 0;
  let lastCorruptError: unknown;
  const items = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .flatMap((line) => {
      let item: RolloutItem | null;
      try {
        item = parseRolloutLine(line);
      } catch (error) {
        // Skip a corrupt interior line rather than aborting the whole
        // history rebuild — one bad row must not strand every later row.
        corruptLines += 1;
        lastCorruptError = error;
        return [];
      }
      return item === null ? [] : [item];
    });
  // If the file contained corrupt rows but nothing at all survived, surface
  // the failure so callers (e.g. conversation replay) can record a replay
  // error instead of silently treating a fully-corrupt rollout as empty
  // history. A partial recovery (at least one good row) is still returned.
  if (items.length === 0 && corruptLines > 0) {
    throw lastCorruptError instanceof Error
      ? lastCorruptError
      : new Error("rollout history is corrupt");
  }
  return items;
}
