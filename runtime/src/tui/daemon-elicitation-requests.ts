import type { JsonObject } from "../app-server/protocol/index.js";

/** How the daemon addresses a request: the fields `elicitation.respond` takes. */
export type DaemonElicitationAddress =
  | { readonly kind: "request_user_input"; readonly requestId: string }
  | {
      readonly kind: "mcp";
      readonly serverName: string;
      readonly requestId: string | number;
    };

interface OpenPrompt {
  readonly controller: AbortController;
  readonly turnId: string | undefined;
  readonly sequence: number | undefined;
}

/** A settled request at an address and turn whose sequence is unknown. */
const ALL = "all";
type SettledMark = number | typeof ALL;

/**
 * Covers every elicitation request a replay can bring back: the daemon
 * replays at most 1000 events of a session, and each request comes with at
 * least its close event.
 */
const DEFAULT_RECORD_LIMIT = 512;

function addressKey(address: DaemonElicitationAddress): string {
  return address.kind === "mcp"
    ? `mcp\u0000${address.serverName}\u0000${String(address.requestId)}`
    : `request_user_input\u0000${address.requestId}`;
}

function turnKey(key: string, turnId: string | undefined): string {
  return `${key}\u0000${turnId ?? ""}`;
}

function closedAddress(payload: JsonObject): DaemonElicitationAddress | undefined {
  const { kind, requestId, serverName } = payload;
  if (kind === "request_user_input" && typeof requestId === "string") {
    return { kind, requestId };
  }
  if (
    kind === "mcp" &&
    typeof serverName === "string" &&
    (typeof requestId === "string" || typeof requestId === "number")
  ) {
    return { kind, serverName, requestId };
  }
  return undefined;
}

/** Map insertion with a size bound that drops the oldest entry. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value as K);
}

/**
 * The daemon elicitations this client shows. Each request occurrence (its
 * `elicitation.respond` address, its turn, and the daemon event sequence when
 * there is one) gets a signal for its prompt.
 *
 * The daemon sends `elicitation_closed` when a request stops being pending:
 * another client answered it, the MCP server cancelled it, or its turn or
 * session stopped. Closing aborts the signal, which takes the prompt off the
 * screen, and the client then sends no answer. A turn's end closes its
 * prompts too: the daemon can no longer take answers for that turn.
 *
 * Events can arrive again (replays after an attach, a second subscription),
 * so a bounded record keeps every answered or closed occurrence closed, and
 * a request older than one already seen at its address never takes over.
 */
export class DaemonElicitationRequests {
  readonly #open = new Map<string, OpenPrompt>();
  /** Highest settled sequence per address and turn. */
  readonly #settled = new Map<string, SettledMark>();
  /** Highest request sequence seen per address. */
  readonly #latest = new Map<string, number>();
  readonly #endedTurns = new Map<string, true>();
  readonly #limit: number;
  #closed = false;

  constructor(recordLimit = DEFAULT_RECORD_LIMIT) {
    this.#limit = recordLimit;
  }

  /**
   * Returns the prompt's signal, or undefined when the request must not be
   * shown: it is already shown, it was answered or closed, its turn ended,
   * or a newer request at its address was already seen. A request replaces
   * the open prompt at its address only when it is provably newer (a higher
   * sequence); otherwise the open prompt stays.
   */
  begin(
    address: DaemonElicitationAddress,
    turnId: string | undefined,
    sequence?: number,
  ): AbortController | undefined {
    if (this.#closed) return undefined;
    const key = addressKey(address);
    if (sequence !== undefined) {
      const latest = this.#latest.get(key);
      // Older than a request already seen at this address: a replay.
      if (latest !== undefined && sequence < latest) return undefined;
      if (latest === undefined || sequence > latest) {
        remember(this.#latest, key, sequence, this.#limit);
      }
    }
    if (turnId !== undefined && this.#endedTurns.has(turnId)) {
      this.#recordSettled(key, turnId, sequence);
      return undefined;
    }
    if (this.#isSettled(key, turnId, sequence)) return undefined;
    const open = this.#open.get(key);
    if (open !== undefined) {
      if (!this.#isNewer(open, turnId, sequence)) return undefined;
      this.#settle(key, open, true);
    }
    const controller = new AbortController();
    this.#open.set(key, { controller, turnId, sequence });
    return controller;
  }

  /** This client answered the prompt; a later delivery never reopens it. */
  finish(address: DaemonElicitationAddress, controller: AbortController): void {
    const key = addressKey(address);
    const open = this.#open.get(key);
    if (open?.controller === controller) this.#settle(key, open, false);
  }

  /** Applies an `elicitation_closed` payload. Returns whether a prompt closed. */
  close(payload: JsonObject): boolean {
    const address = closedAddress(payload);
    if (address === undefined) return false;
    const key = addressKey(address);
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    const open = this.#open.get(key);
    // Same address, other turn: a different request.
    if (
      open !== undefined &&
      (open.turnId === undefined || turnId === undefined || open.turnId === turnId)
    ) {
      this.#settle(key, open, true);
      return true;
    }
    // Not shown here (yet): keep it from opening later.
    this.#recordSettled(key, turnId, undefined);
    return false;
  }

  /** A turn ended: its requests can no longer be answered. */
  noteTurnEnded(turnId: string): void {
    remember(this.#endedTurns, turnId, true, this.#limit);
    for (const [key, open] of this.#open) {
      if (open.turnId === turnId) this.#settle(key, open, true);
    }
  }

  /** The event stream ended: no answer can reach the daemon through it. */
  closeAll(): void {
    this.#closed = true;
    for (const open of this.#open.values()) open.controller.abort();
    this.#open.clear();
  }

  #isNewer(
    open: OpenPrompt,
    turnId: string | undefined,
    sequence: number | undefined,
  ): boolean {
    if (sequence !== undefined && open.sequence !== undefined) {
      return sequence > open.sequence;
    }
    return (
      open.turnId !== undefined &&
      open.turnId !== turnId &&
      this.#endedTurns.has(open.turnId)
    );
  }

  #isSettled(
    key: string,
    turnId: string | undefined,
    sequence: number | undefined,
  ): boolean {
    const mark = this.#settled.get(turnKey(key, turnId));
    if (mark === undefined) return false;
    if (mark === ALL || sequence === undefined) return true;
    return sequence <= mark;
  }

  #recordSettled(
    key: string,
    turnId: string | undefined,
    sequence: number | undefined,
  ): void {
    const settledKey = turnKey(key, turnId);
    const previous = this.#settled.get(settledKey);
    const next: SettledMark =
      previous === ALL || sequence === undefined
        ? ALL
        : Math.max(previous ?? sequence, sequence);
    remember(this.#settled, settledKey, next, this.#limit);
  }

  #settle(key: string, open: OpenPrompt, abort: boolean): void {
    this.#open.delete(key);
    this.#recordSettled(key, open.turnId, open.sequence);
    if (abort) open.controller.abort();
  }
}
