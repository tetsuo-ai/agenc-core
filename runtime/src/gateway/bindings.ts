/**
 * Deterministic sender→agent binding resolution (TODO task 6).
 *
 * Most specific wins, ties broken by declaration order:
 *   1. peer binding   (channelId + peerId match)
 *   2. group binding  (channelId + groupId match)
 *   3. channel default (channelId only, no peer/group)
 *   4. gateway default agent
 *
 * A binding that names BOTH peerId and groupId matches only when both match
 * (more specific than either alone).
 */

import type {
  ChannelConversation,
  ChannelSender,
  GatewayBinding,
} from "./types.js";

export interface ResolvedBinding {
  readonly agent: string;
  /** The rule that matched, for diagnostics; undefined = gateway default. */
  readonly binding?: GatewayBinding;
}

function specificity(binding: GatewayBinding): number {
  if (binding.peerId !== undefined && binding.groupId !== undefined) return 3;
  if (binding.peerId !== undefined) return 2;
  if (binding.groupId !== undefined) return 1;
  return 0;
}

function matches(
  binding: GatewayBinding,
  channelId: string,
  sender: ChannelSender,
  conversation: ChannelConversation,
): boolean {
  if (binding.channelId !== channelId) return false;
  if (binding.peerId !== undefined && binding.peerId !== sender.peerId) {
    return false;
  }
  if (
    binding.groupId !== undefined &&
    (conversation.kind !== "group" || binding.groupId !== conversation.id)
  ) {
    return false;
  }
  return true;
}

export function resolveBinding(options: {
  readonly bindings: readonly GatewayBinding[];
  readonly defaultAgent: string;
  readonly channelId: string;
  readonly sender: ChannelSender;
  readonly conversation: ChannelConversation;
}): ResolvedBinding {
  let best: GatewayBinding | undefined;
  let bestSpecificity = -1;
  for (const binding of options.bindings) {
    if (
      !matches(binding, options.channelId, options.sender, options.conversation)
    ) {
      continue;
    }
    const s = specificity(binding);
    if (s > bestSpecificity) {
      best = binding;
      bestSpecificity = s;
    }
  }
  if (best !== undefined) return { agent: best.agent, binding: best };
  return { agent: options.defaultAgent };
}
