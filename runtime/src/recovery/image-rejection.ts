/**
 * Recovery from a provider that refused an image in the request.
 *
 * Tool results and user attachments are replayed on every later request, so
 * without this an image the provider cannot accept fails the turn and then
 * every turn after it. Recovery records the refused images for the session
 * and the provider and model that refused them (the query projection then
 * replaces each with a short note on requests to that route only) and
 * samples again. It first leaves out only the images this request added after the
 * last assistant message, the usual culprit; if the provider refuses again,
 * it leaves out every image. Each step strictly grows the refused set, so
 * recovery ends: a request without images is never treated as an image
 * refusal.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import {
  imageContentIdentity,
  recordRejectedImages,
  rejectedImagesFor,
  requestImageUrls,
  summarizeProviderReason,
} from "../session/query-image-safety.js";
import { isProviderImageRejection } from "./api-errors.js";

export interface ImageRejectionRecovery {
  /** Images newly left out of the next request. */
  readonly rejected: number;
  /** Whether only the newest images or all remaining ones were left out. */
  readonly scope: "newest" | "all";
  /** One-line summary of the provider's error. */
  readonly reason: string;
}

/**
 * True when the failed sample is an image refusal the turn can recover from:
 * no tool call streamed (resampling cannot repeat an effect) and the request
 * still carries an image to leave out.
 */
export function isRecoverableImageRejection(
  state: Pick<TurnState, "toolUseBlocks" | "messagesForQuery">,
  streamError: unknown,
): boolean {
  return (
    state.toolUseBlocks.length === 0 &&
    isProviderImageRejection(streamError) &&
    requestImageUrls(state.messagesForQuery).length > 0
  );
}

/**
 * Record the images to leave out of the next attempt on `route` (the
 * provider and model that refused them): those the request added after the
 * last assistant message, or, once those are all refused, every image it
 * still carries. Returns `undefined` when no image is left to remove, so the
 * caller surfaces the failure.
 */
export function rejectImagesForRetry(
  session: Session,
  state: Pick<TurnState, "messagesForQuery">,
  streamError: unknown,
  route: string,
): ImageRejectionRecovery | undefined {
  const already = rejectedImagesFor(session, route);
  const pending = (urls: readonly string[]): string[] =>
    urls.filter((url) => already?.has(imageContentIdentity(url)) !== true);
  let scope: ImageRejectionRecovery["scope"] = "newest";
  let urls = pending(
    requestImageUrls(state.messagesForQuery, { newestOnly: true }),
  );
  if (urls.length === 0) {
    scope = "all";
    urls = pending(requestImageUrls(state.messagesForQuery));
  }
  if (urls.length === 0) return undefined;
  const reason = summarizeProviderReason(
    streamError instanceof Error ? streamError.message : String(streamError),
  );
  const rejected = recordRejectedImages(session, route, urls, {
    provider: session.services.provider.name,
    reason,
  });
  return rejected > 0 ? { rejected, scope, reason } : undefined;
}
