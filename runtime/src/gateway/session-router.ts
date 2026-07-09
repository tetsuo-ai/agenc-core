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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { isDaemonAgentGoneError } from "./sdk-daemon-client.js";
import type {
  ChannelAdapter,
  GatewayDaemonClient,
  GatewayPermissionDecision,
  GatewayPermissionRequest,
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
}

export class SessionRouter {
  readonly #path: string;
  readonly #client: GatewayDaemonClient;
  readonly #flushIntervalMs: number;
  readonly #sessions = new Map<string, GatewaySession>();
  #persisted: SessionMapState;
  /** Serializes turns per conversation key: one in-flight turn at a time. */
  readonly #turnLocks = new Map<string, Promise<void>>();

  constructor(options: SessionRouterOptions) {
    this.#path = join(options.agencHome, "gateway", "sessions.json");
    this.#client = options.client;
    this.#flushIntervalMs =
      options.flushIntervalMs ?? STREAM_FLUSH_INTERVAL_MS;
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
    writeFileSync(
      this.#path,
      `${JSON.stringify(this.#persisted, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  static conversationKey(options: {
    readonly channelId: string;
    readonly agent: string;
    readonly conversationId: string;
  }): string {
    return `${options.channelId}|${options.agent}|${options.conversationId}`;
  }

  async #sessionFor(key: string): Promise<GatewaySession> {
    const live = this.#sessions.get(key);
    if (live !== undefined) return live;
    const persistedId = this.#persisted.sessions[key];
    if (persistedId !== undefined) {
      try {
        const attached = await this.#client.attachSession(persistedId);
        this.#sessions.set(key, attached);
        return attached;
      } catch {
        // Stale persisted id (daemon state pruned): fall through to create.
      }
    }
    const created = await this.#client.createSession({ label: key });
    this.#sessions.set(key, created);
    this.#persisted.sessions[key] = created.sessionId;
    this.#save();
    return created;
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
    readonly adapter: ChannelAdapter;
    readonly conversationId: string;
    onPermissionRequest(
      request: GatewayPermissionRequest,
    ): Promise<GatewayPermissionDecision>;
  }): Promise<GatewayPromptResult> {
    const previous = this.#turnLocks.get(options.key) ?? Promise.resolve();
    let release!: () => void;
    this.#turnLocks.set(
      options.key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    try {
      const attempt = async (
        session: GatewaySession,
      ): Promise<GatewayPromptResult> => {
        let buffer = "";
        let sentMessageId: string | null = null;
        let lastFlush = 0;
        let flushing = Promise.resolve();

        const flush = (force: boolean): Promise<void> => {
          if (buffer.length === 0) return flushing;
          if (!options.adapter.supportsEdit && !force) return flushing;
          const now = Date.now();
          if (!force && now - lastFlush < this.#flushIntervalMs) {
            return flushing;
          }
          lastFlush = now;
          const text = buffer;
          flushing = flushing.then(async () => {
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
          });
          return flushing;
        };

        const result = await session.prompt(options.text, {
          onEvent: (event) => {
            if (event.type === "text") {
              buffer += event.delta;
              void flush(false);
            }
          },
          onPermissionRequest: options.onPermissionRequest,
        });

        // Final state always lands, even for non-edit adapters.
        if (result.finalMessage.length > 0) {
          buffer = result.finalMessage;
        }
        await flush(true);
        return result;
      };

      const session = await this.#sessionFor(options.key);
      try {
        return await attempt(session);
      } catch (error) {
        // The daemon lost this session's backing agent (daemon restart,
        // agent stopped). Provision fresh and retry ONCE; a second failure
        // propagates. History is gone with the agent — acceptable, the
        // alternative is a permanently dead conversation.
        if (!isDaemonAgentGoneError(error)) throw error;
        this.#evictSession(options.key);
        const fresh = await this.#sessionFor(options.key);
        return await attempt(fresh);
      }
    } finally {
      release();
    }
  }
}
