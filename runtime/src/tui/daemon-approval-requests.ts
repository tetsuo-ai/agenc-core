import type { JsonObject } from "../app-server/protocol/index.js";

interface PendingApproval {
  readonly controller: AbortController;
  readonly callId: string;
  readonly sourceConversationId: string | undefined;
  readonly turnId: string | undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Interactive cards belong to approval occurrences, not reusable tool calls. */
export class DaemonApprovalRequests {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #settled = new Set<string>();
  #closed = false;

  constructor(private readonly replayCapacity: number) {}

  begin(payload: JsonObject): AbortController | undefined {
    if (this.#closed) return;
    const requestId = stringField(payload.callId);
    if (requestId === undefined || this.#pending.has(requestId) || this.#settled.has(requestId)) return;
    const controller = new AbortController();
    this.#pending.set(requestId, {
      controller,
      callId: stringField(payload.toolCallId) ?? requestId,
      sourceConversationId: stringField(payload.sourceConversationId),
      turnId: stringField(payload.turnId),
    });
    return controller;
  }

  settleEvent(type: unknown, payload: JsonObject, envelopeTurnId?: unknown): boolean {
    if (this.#closed) return true;
    if (type === "permission_decision") {
      // Child forwarding supplies the namespaced requestId; root journal
      // decisions bind requestEventId. Only legacy events use callId itself.
      const requestId = stringField(payload.requestId) ??
        stringField(payload.requestEventId) ?? stringField(payload.callId);
      if (requestId !== undefined) this.#settle(requestId);
      return true;
    }
    if (type !== "tool_call_completed") return false;
    const source = stringField(payload.sourceConversationId);
    const turnId = stringField(envelopeTurnId) ?? stringField(payload.turnId);
    for (const [requestId, pending] of this.#pending) {
      if (pending.callId !== payload.callId || pending.sourceConversationId !== source) continue;
      if (turnId !== undefined && pending.turnId !== turnId) continue;
      this.#settle(requestId);
    }
    return true;
  }

  finish(requestId: string, controller: AbortController): void {
    if (this.release(requestId, controller)) this.#rememberSettled(requestId);
  }

  release(requestId: string, controller: AbortController): boolean {
    if (this.#pending.get(requestId)?.controller !== controller) return false;
    return this.#pending.delete(requestId);
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#settled.clear();
  }

  #settle(requestId: string): void {
    this.#pending.get(requestId)?.controller.abort();
    this.#pending.delete(requestId);
    this.#rememberSettled(requestId);
  }

  #rememberSettled(requestId: string): void {
    this.#settled.add(requestId);
    // Match the connection's bounded replay window; settled cached requests
    // may be replayed after their decision and must not recreate a modal.
    if (this.#settled.size > this.replayCapacity) {
      this.#settled.delete(this.#settled.values().next().value!);
    }
  }
}
