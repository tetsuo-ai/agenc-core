/**
 * Resolve the dim placeholder rendered inside an empty composer.
 *
 * Upstream weaves several signals through this hook (queue hints,
 * teammate-message-mode hint, proactive-mode suppression, example-prompt
 * cache). AgenC ships a much simpler surface: one static placeholder for
 * the first turn, and a queued-message hint when the operator has
 * staged commands that they can pull back with `↑`.
 *
 * Returning `undefined` keeps the placeholder slot empty so the buffer
 * renderer can fall back to its own default (e.g., "Ask AgenC to do
 * anything").
 */

import { useMemo } from "react";

const DEFAULT_PLACEHOLDER = "Ask AgenC to do anything";

type Props = {
  readonly input: string;
  readonly submitCount: number;
  /**
   * Number of editable queued commands the operator has parked for the
   * next turn. The hint only renders before the first submit so first-
   * time users see it once and fade it out as they get going.
   */
  readonly queuedEditableCommandCount?: number;
};

export function usePromptInputPlaceholder({
  input,
  submitCount,
  queuedEditableCommandCount,
}: Props): string | undefined {
  return useMemo(() => {
    if (input !== "") return undefined;
    if (submitCount === 0 && (queuedEditableCommandCount ?? 0) > 0) {
      return "Press up to edit queued messages";
    }
    if (submitCount === 0) {
      return DEFAULT_PLACEHOLDER;
    }
    return undefined;
  }, [input, submitCount, queuedEditableCommandCount]);
}
