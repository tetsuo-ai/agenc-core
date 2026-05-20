import type { RuntimeMessage } from "./types.js";

type SnipMetadata = {
  readonly removedUuids?: readonly string[];
};

type SnipCandidate = RuntimeMessage & {
  readonly snipMetadata?: SnipMetadata;
  readonly uuid?: string;
};

export function isSnipBoundaryMessage(candidate: unknown): candidate is SnipCandidate {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { readonly type?: unknown }).type === "system" &&
    (candidate as { readonly subtype?: unknown }).subtype === "snip_boundary"
  );
}

export function projectSnippedView<T extends RuntimeMessage>(messages: readonly T[]): T[] {
  const removed = new Set<string>();
  for (const message of messages) {
    if (!isSnipBoundaryMessage(message)) continue;
    for (const uuid of message.snipMetadata?.removedUuids ?? []) {
      removed.add(uuid);
    }
  }
  if (removed.size === 0) return [...messages];
  return messages.filter(message => {
    const uuid = (message as SnipCandidate).uuid;
    return uuid === undefined || !removed.has(uuid);
  });
}
