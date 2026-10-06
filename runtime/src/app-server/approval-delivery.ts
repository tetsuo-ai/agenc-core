import type { JsonObject } from "./protocol/index.js";

/**
 * What became of a session notification the daemon published. The approval
 * broker reads it for a forwarded sub-agent request: a request no client
 * received and no client will list must not wait for an answer.
 */
export interface AgenCSessionEventDelivery {
  /** Clients the notification was handed to; each accepted its method. */
  readonly deliveredClientIds: readonly string[];
  /** A connected client or remote device shows pending requests from a listing. */
  readonly pendingListing?: boolean;
}

/**
 * The daemon's result for one published notification. For a permission
 * request that reached nobody live, it also says whether a client that lists
 * pending requests is connected; that check runs only in that case.
 */
export async function sessionEventDelivery(
  event: JsonObject,
  broadcast: { readonly deliveredClientIds: readonly string[] },
  pendingListing: () => boolean | Promise<boolean>,
): Promise<AgenCSessionEventDelivery> {
  const deliveredClientIds = [...broadcast.deliveredClientIds];
  if (event.method !== "event.permission_request" || deliveredClientIds.length > 0) {
    return { deliveredClientIds };
  }
  return { deliveredClientIds, pendingListing: await pendingListing() };
}

/**
 * True only for a result that proves nobody can show the request. A binding
 * that reports nothing (an embedder or an older wiring) is not proof.
 */
export function isUndeliverableApproval(delivery: unknown): boolean {
  if (delivery === null || typeof delivery !== "object") return false;
  const { deliveredClientIds, pendingListing } = delivery as Partial<AgenCSessionEventDelivery>;
  return Array.isArray(deliveredClientIds) && deliveredClientIds.length === 0 && pendingListing !== true;
}
