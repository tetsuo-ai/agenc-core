import type { JsonObject } from "../app-server/protocol/index.js";

/** How the daemon addresses a request: the fields `elicitation.respond` takes. */
export type DaemonElicitationAddress =
  | { readonly kind: "request_user_input"; readonly requestId: string }
  | {
      readonly kind: "mcp";
      readonly serverName: string;
      readonly requestId: string | number;
    };

interface PendingElicitation {
  readonly controller: AbortController;
  readonly turnId: string | undefined;
}

function addressKey(address: DaemonElicitationAddress): string {
  return address.kind === "mcp"
    ? `mcp\u0000${address.serverName}\u0000${String(address.requestId)}`
    : `request_user_input\u0000${address.requestId}`;
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

/**
 * The daemon elicitations this client shows. Each one gets a signal for its
 * prompt. The daemon sends `elicitation_closed` when a request stops being
 * pending: another client answered it, the MCP server cancelled it, or its
 * turn or session stopped. Closing aborts the signal, which takes the prompt
 * off the screen, and the client then sends no answer for it.
 */
export class DaemonElicitationRequests {
  readonly #pending = new Map<string, PendingElicitation>();
  #closed = false;

  /**
   * Returns the prompt's signal, or undefined when this request is already
   * shown (the same event delivered again). A request at the same address
   * from another turn replaces the old one: the daemon keeps one per address.
   */
  begin(
    address: DaemonElicitationAddress,
    turnId: string | undefined,
  ): AbortController | undefined {
    if (this.#closed) return undefined;
    const key = addressKey(address);
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      if (
        existing.turnId === undefined ||
        turnId === undefined ||
        existing.turnId === turnId
      ) {
        return undefined;
      }
      existing.controller.abort();
    }
    const controller = new AbortController();
    this.#pending.set(key, { controller, turnId });
    return controller;
  }

  /** The prompt settled here; forget it unless a newer request replaced it. */
  finish(address: DaemonElicitationAddress, controller: AbortController): void {
    const key = addressKey(address);
    if (this.#pending.get(key)?.controller === controller) {
      this.#pending.delete(key);
    }
  }

  /** Applies an `elicitation_closed` payload. Returns whether a prompt closed. */
  close(payload: JsonObject): boolean {
    const address = closedAddress(payload);
    if (address === undefined) return false;
    const key = addressKey(address);
    const pending = this.#pending.get(key);
    if (pending === undefined) return false;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    // Same address, other turn: a different request.
    if (
      pending.turnId !== undefined &&
      turnId !== undefined &&
      pending.turnId !== turnId
    ) {
      return false;
    }
    this.#pending.delete(key);
    pending.controller.abort();
    return true;
  }

  /** The event stream ended: no answer can reach the daemon through it. */
  closeAll(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
  }
}
