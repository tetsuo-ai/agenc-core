import type { AgentStatus, Session } from "../session/session.js";
import { threadConfigSnapshot } from "../session/turn-context.js";
import type { InterAgentCommunication } from "./mailbox.js";
import type { AgentPath, AgentRegistry, ThreadId } from "./registry.js";
import type { AgentControl, LiveAgent } from "./control.js";

export type ThreadManagerOp =
  | { readonly type: "user_input"; readonly input: string }
  | {
      readonly type: "inter_agent_communication";
      readonly communication: Omit<InterAgentCommunication, "seq" | "direction">;
    }
  | { readonly type: "interrupt"; readonly reason?: string }
  | { readonly type: "shutdown"; readonly reason?: string }
  | { readonly type: "refresh_mcp_servers"; readonly config: unknown };

export interface ManagedThread {
  readonly threadId: ThreadId;
  readonly agentPath?: AgentPath;
  readonly parentThreadId?: ThreadId;
  readonly kind: "root" | "agent";
  status(): AgentStatus;
  submit(op: ThreadManagerOp): Promise<string>;
  shutdown(reason?: string): Promise<void>;
  configSnapshot?(): Record<string, unknown> | undefined;
  rolloutPath?(): string | undefined;
}

export interface ThreadShutdownReport {
  readonly completed: ThreadId[];
  readonly submitFailed: ThreadId[];
  readonly timedOut: ThreadId[];
}

type ThreadCreatedListener = (threadId: ThreadId) => void;

export interface ThreadManagerOpts {
  readonly rootSession?: Session;
  readonly control?: AgentControl;
  readonly registry?: AgentRegistry;
}

export interface NewManagedThread {
  readonly threadId: ThreadId;
  readonly thread: ManagedThread;
}

export type SpawnManagedLiveAgentOptions = Parameters<AgentControl["spawn"]>[0];

export class ThreadNotManagedError extends Error {
  constructor(threadId: ThreadId) {
    super(`thread not found: ${threadId}`);
    this.name = "ThreadNotManagedError";
  }
}

export class ThreadManager {
  private readonly threads = new Map<ThreadId, ManagedThread>();
  private readonly createdListeners = new Set<ThreadCreatedListener>();
  private control: AgentControl | undefined;
  private registry: AgentRegistry | undefined;

  constructor(rootOrOpts?: Session | ThreadManagerOpts) {
    const opts =
      rootOrOpts && "conversationId" in rootOrOpts
        ? { rootSession: rootOrOpts }
        : (rootOrOpts ?? {});
    this.control = opts.control;
    this.registry = opts.registry;
    if (opts.rootSession) this.registerRootSession(opts.rootSession);
  }

  bindAgentControl(control: AgentControl): void {
    this.control = control;
  }

  bindRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  registerRootSession(session: Session): ManagedThread {
    const thread: ManagedThread = {
      threadId: session.conversationId,
      agentPath: "/root",
      kind: "root",
      status: () => session.agentStatus.value,
      submit: (op) => submitToSession(session, op),
      shutdown: async () => {
        await session.shutdown();
      },
      configSnapshot: () =>
        threadConfigSnapshot(session.sessionConfiguration) as unknown as Record<
          string,
          unknown
        >,
      rolloutPath: () => session.rolloutStore?.rolloutPath,
    };
    if (
      typeof this.registry?.registerRootThread === "function" &&
      typeof session.conversationId === "string"
    ) {
      this.registry.registerRootThread(session.conversationId);
    }
    this.setThread(thread);
    return thread;
  }

  async startThread(session: Session): Promise<NewManagedThread> {
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async startThreadWithTools(session: Session): Promise<NewManagedThread> {
    return this.startThread(session);
  }

  async resumeThreadWithHistory(session: Session): Promise<NewManagedThread> {
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async resumeThreadFromRollout(session: Session): Promise<NewManagedThread> {
    return this.resumeThreadWithHistory(session);
  }

  async forkThread(session: Session): Promise<NewManagedThread> {
    const thread = this.registerRootSession(session);
    return { threadId: thread.threadId, thread };
  }

  async spawnLiveAgent(
    opts: SpawnManagedLiveAgentOptions,
  ): Promise<LiveAgent> {
    if (!this.control) {
      throw new Error("ThreadManager cannot spawn an agent before AgentControl is bound");
    }
    const live = await this.control.spawnLiveAgentForThreadManager(opts);
    const parentThreadId =
      typeof this.registry?.agentIdForPath === "function"
        ? this.registry.agentIdForPath(opts.parentPath)
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
    const thread: ManagedThread = {
      threadId: live.agentId,
      agentPath: live.agentPath,
      kind: "agent",
      ...(opts.parentThreadId !== undefined
        ? { parentThreadId: opts.parentThreadId }
        : {}),
      status: () => live.status.value,
      submit: async (op) => {
        switch (op.type) {
          case "user_input":
            live.downInbox.send({
              author: live.agentPath,
              recipient: live.agentPath,
              content: op.input,
              triggerTurn: true,
              direction: "down",
              metadata: { kind: "user_input" },
            });
            return live.agentId;
          case "inter_agent_communication":
            live.downInbox.send({
              ...op.communication,
              direction: "down",
              metadata: { kind: "inter_agent_communication" },
            });
            return live.agentId;
          case "interrupt":
            if (!live.abortController.signal.aborted) {
              live.abortController.abort(op.reason ?? "interrupt");
            }
            live.status.markInterrupted(live.agentId, op.reason ?? "interrupt");
            return live.agentId;
          case "shutdown":
            live.upInbox.close(op.reason ?? "shutdown");
            live.downInbox.close(op.reason ?? "shutdown");
            live.status.markShutdown();
            live.status.complete();
            return live.agentId;
          case "refresh_mcp_servers":
            return live.agentId;
        }
      },
      shutdown: async (reason) => {
        await thread.submit({ type: "shutdown", reason: reason ?? "shutdown" });
      },
      configSnapshot: () => live.configSnapshot,
      rolloutPath: () => live.rolloutPath,
    };
    this.setThread(thread);
    return thread;
  }

  getThread(threadId: ThreadId): ManagedThread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ThreadNotManagedError(threadId);
    return thread;
  }

  hasThread(threadId: ThreadId): boolean {
    return this.threads.has(threadId);
  }

  listThreadIds(): readonly ThreadId[] {
    return Array.from(this.threads.keys());
  }

  removeThread(threadId: ThreadId): ManagedThread | undefined {
    const thread = this.threads.get(threadId);
    this.threads.delete(threadId);
    return thread;
  }

  async sendOp(threadId: ThreadId, op: ThreadManagerOp): Promise<string> {
    return this.getThread(threadId).submit(op);
  }

  async shutdownAllThreadsBounded(timeoutMs: number): Promise<ThreadShutdownReport> {
    const entries = Array.from(this.threads.entries());
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
      this.threads.delete(threadId);
    }
    report.completed.sort();
    report.submitFailed.sort();
    report.timedOut.sort();
    return report;
  }

  subscribeThreadCreated(listener: ThreadCreatedListener): () => void {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  private setThread(thread: ManagedThread): void {
    const existed = this.threads.has(thread.threadId);
    this.threads.set(thread.threadId, thread);
    if (existed) return;
    for (const listener of this.createdListeners) {
      listener(thread.threadId);
    }
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
    case "inter_agent_communication":
      session.mailbox.send({
        ...op.communication,
        direction: "up",
        metadata: { kind: "inter_agent_communication" },
      });
      if (op.communication.triggerTurn) {
        await session.submit(op.communication.content);
      }
      return session.conversationId;
    case "interrupt":
      session.abortTerminal("user_interrupt");
      return session.conversationId;
    case "shutdown":
      await session.shutdown();
      return session.conversationId;
    case "refresh_mcp_servers":
      await session.services.mcpManager.refreshFromConfig?.(op.config);
      return session.conversationId;
  }
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
