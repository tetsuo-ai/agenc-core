import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  getSessionCronTasks,
  removeSessionCronTasks,
  removeSessionCronTasksForConversation,
} from "../bootstrap/state.js";
import { CronScheduler } from "../utils/cronScheduler.js";
import { listAllCronTasks, listSessionCronTasks, mutateCronFile, type CronTask } from "../utils/cronTasks.js";
import { emitWarning } from "./event-log.js";
import type { Session } from "./session.js";

type SessionCronOwner = {
  readonly scheduler: CronScheduler;
  readonly workspaceRoot: string;
  closed: boolean;
  ready: boolean;
  sessionOnly: boolean;
};

const sessionOwners = new WeakMap<Session, SessionCronOwner>();
const workspaceOwners = new Map<string, Set<SessionCronOwner>>();

class ScheduledTaskCancelled extends Error {}

function matchesScheduledOccurrence(current: CronTask, expected: Readonly<CronTask>): boolean {
  return current.id === expected.id && current.cron === expected.cron &&
    current.prompt === expected.prompt && current.createdAt === expected.createdAt &&
    current.recurring === expected.recurring && current.lastFiredAt === expected.lastFiredAt &&
    current.deliver === undefined;
}

async function claimScheduledOccurrence(
  task: Readonly<CronTask>,
  firedAt: number,
  conversationId: string,
  workspaceRoot: string,
  assertActive: () => void,
): Promise<boolean> {
  assertActive();
  if (task.durable === false) {
    const current = getSessionCronTasks().find((candidate) =>
      candidate.queueOwner.conversationId === conversationId &&
      matchesScheduledOccurrence(candidate, task),
    );
    if (current === undefined) return false;
    if (task.recurring) current.lastFiredAt = firedAt;
    else removeSessionCronTasks([task.id], conversationId);
    return true;
  }
  return mutateCronFile(workspaceRoot, (state) => {
    assertActive();
    const current = state.tasks.find((candidate) => matchesScheduledOccurrence(candidate, task));
    if (current === undefined) return false;
    if (task.recurring) current.lastFiredAt = firedAt;
    else state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
    return true;
  });
}

export async function startSessionCronScheduler(
  session: Session,
  workspaceRoot: string,
  options: { readonly sessionOnly?: boolean } = {},
): Promise<CronScheduler> {
  session.abortController.signal.throwIfAborted();
  const startupSignal = session.services.mcpStartupCancellationToken.signal;
  startupSignal?.throwIfAborted();
  const canonicalRoot = realpathSync(resolve(workspaceRoot));
  let owner = sessionOwners.get(session);
  if (owner !== undefined && (owner.closed || owner.workspaceRoot !== canonicalRoot)) {
    throw new Error("Cron scheduler session ownership is no longer valid");
  }
  if (owner === undefined) {
    const owners = workspaceOwners.get(canonicalRoot) ?? new Set<SessionCronOwner>();
    workspaceOwners.set(canonicalRoot, owners);
    let currentOwner: SessionCronOwner;
    const scheduler = new CronScheduler({
      onLoadError: (error) => {
        if (currentOwner.closed) return;
        emitWarning(session.eventLog, session.nextInternalSubId(),
          "cron_storage_unavailable",
          `Durable scheduled tasks unavailable: ${error instanceof Error ? error.message : String(error)}`);
      },
      loadTasks: async (directory, conversationId) => {
        // Only Linux currently admits descriptor-confined durable writes.
        // A read-only durable record must never reach onAccepted and stop
        // this session's independent in-memory scheduler.
        const tasks = process.platform === "linux"
          ? await listAllCronTasks(directory, conversationId)
          : listSessionCronTasks(conversationId);
        if (currentOwner.closed) return [];
        const ownsDurableTasks = process.platform === "linux" &&
          [...owners].find((candidate) => candidate.ready && !candidate.sessionOnly) === currentOwner;
        return tasks.filter((task) => task.durable === false || ownsDurableTasks);
      },
      enqueue: async (command, task, firedAt) => {
        let accepted = false;
        const assertActive = (): void => {
          if (currentOwner.closed) throw new Error("Cron scheduler session is closed");
          if (currentOwner.sessionOnly && task.durable !== false) {
            throw new ScheduledTaskCancelled();
          }
          session.abortController.signal.throwIfAborted();
          startupSignal?.throwIfAborted();
        };
        try {
          assertActive();
          await session.submit(command.value, {
            displayUserMessage: null,
            onAccepted: async () => {
              if (!await claimScheduledOccurrence(
                task, firedAt, session.conversationId, canonicalRoot, assertActive,
              )) throw new ScheduledTaskCancelled();
              accepted = true;
              assertActive();
            },
          });
        } catch (error) {
          if (error instanceof ScheduledTaskCancelled) return "cancelled" as const;
          // A durable claim can fail independently of session jobs. Leave
          // those jobs armed even if durable storage becomes unavailable.
          if (task.durable === false) scheduler.stop();
          if (accepted || !currentOwner.closed) {
            emitWarning(
              session.eventLog,
              session.nextInternalSubId(),
              "scheduled_turn_failed",
              `Scheduled turn failed ${accepted ? "after acceptance; the attempt will not be replayed" : "before acceptance; the job is retained"}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (!accepted && task.durable === false) throw error;
        }
        return accepted ? "accepted" as const : "cancelled" as const;
      },
    });
    currentOwner = { scheduler, workspaceRoot: canonicalRoot, closed: false, ready: false, sessionOnly: options.sessionOnly === true };
    owner = currentOwner;
    owners.add(owner);
    sessionOwners.set(session, owner);
    let closePromise: Promise<void> | undefined;
    let unsubscribeReady = (): void => {};
    const close = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      currentOwner.closed = true;
      scheduler.stop();
      unsubscribeReady();
      removeSessionCronTasksForConversation(session.conversationId);
      session.abortController.signal.removeEventListener("abort", onAbort);
      startupSignal?.removeEventListener("abort", onAbort);
      closePromise = scheduler.drain().then(async () => {
        owners.delete(currentOwner);
        sessionOwners.delete(session);
        if (owners.size === 0) workspaceOwners.delete(canonicalRoot);
        if (!currentOwner.sessionOnly) {
          await Promise.all([...owners].map((remaining) => remaining.scheduler.reschedule()));
        }
      });
      return closePromise;
    };
    const onAbort = (): void => {
      void close().catch(() => undefined);
    };
    session.abortController.signal.addEventListener("abort", onAbort, { once: true });
    startupSignal?.addEventListener("abort", onAbort, { once: true });
    session.onBeforeDurableClose(close);
    unsubscribeReady = session.onTurnDriverReady(() => {
      if (currentOwner.closed) return;
      owners.delete(currentOwner);
      owners.add(currentOwner);
      currentOwner.ready = true;
      scheduler.start({
        queueOwner: { kind: "session", conversationId: session.conversationId },
        workspaceRoot: canonicalRoot,
        sessionOnly: currentOwner.sessionOnly,
      });
    });
  }
  if (options.sessionOnly !== undefined) owner.sessionOnly = options.sessionOnly;
  if (owner.ready) {
    owner.scheduler.start({
      queueOwner: { kind: "session", conversationId: session.conversationId },
      workspaceRoot: canonicalRoot,
      sessionOnly: owner.sessionOnly,
    });
  }
  if (owner.sessionOnly) {
    await owner.scheduler.reschedule();
  } else {
    await Promise.all(
      [...(workspaceOwners.get(canonicalRoot) ?? [])].map((current) => current.scheduler.reschedule()),
    );
  }
  return owner.scheduler;
}
