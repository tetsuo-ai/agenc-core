/**
 * Conversation → daemon-session routing + turn streaming (TODO task 6).
 *
 * One daemon session per (channel, agent, conversation) triple, created
 * lazily and persisted to `<agencHome>/gateway/sessions.json` so a gateway
 * restart reattaches instead of forking history. Two different agents never
 * share a session (binding isolation).
 *
 * Streaming coalescing: adapters that support edit-in-place get a throttled
 * live-updating message; others get one message per completed turn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { ConversationRecoveryStore } from "./conversation-recovery.js";
import { isDaemonAgentGoneError } from "./sdk-daemon-client.js";
import type {
  ChannelAdapter,
  GatewayDaemonClient,
  GatewayPermissionDecision,
  GatewayPermissionRequest,
  GatewayPromptHandlers,
  GatewayPromptResult,
  GatewaySession,
} from "./types.js";

export const STREAM_FLUSH_INTERVAL_MS = 750;

interface SessionMapState {
  readonly version: 1;
  sessions: Record<string, string>;
}

export interface SessionRouterOptions {
  readonly agencHome: string;
  readonly client: GatewayDaemonClient;
  readonly flushIntervalMs?: number;
  readonly now?: () => number;
  readonly recoveryTtlMs?: number;
  readonly recoveryMaxConversations?: number;
  readonly recoveryMaxTurns?: number;
}

interface RoutedSession {
  readonly session: GatewaySession;
  readonly created: boolean;
}

type StreamedTurnOutcome =
  | { readonly kind: "completed"; readonly result: GatewayPromptResult }
  | { readonly kind: "prompt_failed" | "delivery_failed"; readonly error: unknown };

async function streamPromptToAdapter(options: {
  readonly session: GatewaySession;
  readonly promptText: string;
  readonly adapter: ChannelAdapter;
  readonly conversationId: string;
  readonly flushIntervalMs: number;
  readonly onPermissionRequest: GatewayPromptHandlers["onPermissionRequest"];
}): Promise<StreamedTurnOutcome> {
  let buffer = "";
  let sentMessageId: string | null = null;
  let lastFlush = 0;
  let flushing = Promise.resolve();
  const delivery: { failure?: { readonly error: unknown } } = {};

  const flush = (force: boolean): Promise<void> => {
    if (delivery.failure !== undefined || buffer.length === 0) return flushing;
    if (!options.adapter.supportsEdit && !force) return flushing;
    const now = Date.now();
    if (!force && now - lastFlush < options.flushIntervalMs) return flushing;
    lastFlush = now;
    const text = buffer;
    flushing = flushing.then(async () => {
      if (delivery.failure !== undefined) return;
      if (options.adapter.supportsEdit && sentMessageId !== null) {
        await options.adapter.send({
          conversationId: options.conversationId,
          text,
          editMessageId: sentMessageId,
        });
      } else {
        sentMessageId = await options.adapter.send({
          conversationId: options.conversationId,
          text,
        });
      }
    }).catch((error: unknown) => {
      delivery.failure ??= { error };
    });
    return flushing;
  };

  const outcome = await Promise.resolve().then(() =>
    options.session.prompt(options.promptText, {
      onEvent: (event) => {
        if (event.type === "text" && delivery.failure === undefined) {
          buffer += event.delta;
          void flush(false);
        }
      },
      onPermissionRequest: options.onPermissionRequest,
    }),
  ).then(
    (result): StreamedTurnOutcome => ({ kind: "completed", result }),
    (error: unknown): StreamedTurnOutcome => ({ kind: "prompt_failed", error }),
  );
  if (outcome.kind === "completed") {
    if (outcome.result.finalMessage.length > 0) {
      buffer = outcome.result.finalMessage;
    }
    await flush(true);
  }
  await flushing;
  return delivery.failure === undefined
    ? outcome
    : { kind: "delivery_failed", error: delivery.failure.error };
}

export class SessionRouter {
  readonly #path: string;
  readonly #client: GatewayDaemonClient;
  readonly #flushIntervalMs: number;
  readonly #recovery: ConversationRecoveryStore;
  readonly #sessions = new Map<string, GatewaySession>();
  #persisted: SessionMapState;
  /** Serializes turns per conversation key: one in-flight turn at a time. */
  readonly #turnLocks = new Map<string, Promise<void>>();

  constructor(options: SessionRouterOptions) {
    this.#path = join(options.agencHome, "gateway", "sessions.json");
    this.#client = options.client;
    this.#flushIntervalMs =
      options.flushIntervalMs ?? STREAM_FLUSH_INTERVAL_MS;
    this.#recovery = new ConversationRecoveryStore({
      path: join(
        options.agencHome,
        "gateway",
        "conversation-recovery.json",
      ),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.recoveryTtlMs !== undefined
        ? { ttlMs: options.recoveryTtlMs }
        : {}),
      ...(options.recoveryMaxConversations !== undefined
        ? { maxConversations: options.recoveryMaxConversations }
        : {}),
      ...(options.recoveryMaxTurns !== undefined
        ? { maxTurns: options.recoveryMaxTurns }
        : {}),
    });
    this.#persisted = this.#load();
  }

  #load(): SessionMapState {
    if (!existsSync(this.#path)) return { version: 1, sessions: {} };
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        (raw as { version?: unknown }).version === 1 &&
        typeof (raw as { sessions?: unknown }).sessions === "object" &&
        (raw as { sessions?: unknown }).sessions !== null
      ) {
        const sessions: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          (raw as SessionMapState).sessions,
        )) {
          if (typeof value === "string") sessions[key] = value;
        }
        return { version: 1, sessions };
      }
    } catch {
      // Corrupt map = start fresh sessions; history stays in the daemon.
    }
    return { version: 1, sessions: {} };
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    // Atomic replace (todo-128): tmp + rename, same pattern as budget ledger.
    const tmp = `${this.#path}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify(this.#persisted, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(tmp, this.#path);
  }

  static conversationKey(options: {
    readonly channelId: string;
    readonly agent: string;
    readonly conversationId: string;
  }): string {
    return `${options.channelId}|${options.agent}|${options.conversationId}`;
  }

  async #sessionFor(key: string): Promise<RoutedSession> {
    const live = this.#sessions.get(key);
    if (live !== undefined) return { session: live, created: false };
    const persistedId = this.#persisted.sessions[key];
    if (persistedId !== undefined) {
      try {
        const attached = await this.#client.attachSession(persistedId);
        this.#sessions.set(key, attached);
        return { session: attached, created: false };
      } catch {
        // Stale persisted id (daemon state pruned): fall through to create.
      }
    }
    const created = await this.#client.createSession({ label: key });
    this.#sessions.set(key, created);
    this.#persisted.sessions[key] = created.sessionId;
    this.#save();
    return { session: created, created: true };
  }

  #textForSession(key: string, text: string, created: boolean): string {
    if (!created) return text;
    const recovery = this.#recovery.recoveryPrompt(key);
    return recovery === undefined ? text : `${recovery}\n\n${text}`;
  }

  /**
   * Drop a conversation's session from the live cache and the persisted map.
   * Used when the daemon reports its backing agent gone (daemon restart,
   * agent stopped) so the next turn provisions a fresh session.
   */
  #evictSession(key: string): void {
    this.#sessions.delete(key);
    if (this.#persisted.sessions[key] !== undefined) {
      delete this.#persisted.sessions[key];
      this.#save();
    }
  }

  /**
   * Run one prompt turn for a conversation, streaming coalesced output to
   * the adapter. Turns within one conversation are serialized; different
   * conversations run concurrently.
   */
  async runTurn(options: {
    readonly key: string;
    readonly text: string;
    /** Sanitized user-visible text only; never pass server evidence here. */
    readonly memoryText?: string;
    readonly adapter: ChannelAdapter;
    readonly conversationId: string;
    onPermissionRequest(
      request: GatewayPermissionRequest,
    ): Promise<GatewayPermissionDecision>;
  }): Promise<GatewayPromptResult> {
    const previous = this.#turnLocks.get(options.key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#turnLocks.set(options.key, lock);
    await previous;
    try {
      const attempt = (
        session: GatewaySession,
        promptText: string,
      ): Promise<StreamedTurnOutcome> =>
        streamPromptToAdapter({
          session,
          promptText,
          adapter: options.adapter,
          conversationId: options.conversationId,
          flushIntervalMs: this.#flushIntervalMs,
          onPermissionRequest: options.onPermissionRequest,
        });

      const routed = await this.#sessionFor(options.key);
      let outcome = await attempt(
        routed.session,
        this.#textForSession(options.key, options.text, routed.created),
      );
      if (
        outcome.kind === "prompt_failed" &&
        isDaemonAgentGoneError(outcome.error)
      ) {
        // The daemon lost this session's backing agent (daemon restart,
        // agent stopped). Provision fresh and retry ONCE; a second failure
        // propagates. The bounded recovery journal supplies recent context
        // to the fresh session without replaying server evidence or secrets.
        this.#evictSession(options.key);
        const fresh = await this.#sessionFor(options.key);
        outcome = await attempt(
          fresh.session,
          this.#textForSession(options.key, options.text, fresh.created),
        );
      }
      if (outcome.kind !== "completed") throw outcome.error;
      const result = outcome.result;
      if (options.memoryText !== undefined) {
        try {
          this.#recovery.record(
            options.key,
            options.memoryText,
            result.finalMessage,
          );
        } catch {
          // Recovery is best-effort and must never turn a completed answer
          // into a failed gateway turn (for example on a read-only disk).
        }
      }
      return result;
    } finally {
      release();
      if (this.#turnLocks.get(options.key) === lock) {
        this.#turnLocks.delete(options.key);
      }
    }
  }
}
