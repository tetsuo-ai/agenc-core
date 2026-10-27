import { useCallback, useRef, useState } from "react";
import type { Key } from "../ink.js";
import type { InputEvent } from "../ink/events/input-event.js";

export const APPROVAL_TYPING_QUIET_MS = 500;

export interface ApprovalComposerDraft {
  readonly text: string;
  onInput(input: string, key: Key): void;
}

/** Keep typing and paste bursts out of the permission decision shortcuts. */
export function useApprovalTypingGuard(typedConfirmation = false, composerDraft?: ApprovalComposerDraft) {
  const lastTyping = useRef(Number.NEGATIVE_INFINITY);
  const typedSinceChoice = useRef(false);
  const [waiting, setWaiting] = useState(false);
  // Preserve a draft that was in progress when the card appeared. An empty
  // composer leaves focus on the card, including its typed confirmation.
  const draftFocusedRef = useRef(composerDraft !== undefined && composerDraft.text.length > 0);
  const [draftFocused, setDraftFocused] = useState(draftFocusedRef.current);
  const blockTyping = useCallback((input: string, key: Key, event: InputEvent): boolean => {
    // Deliberate cancellation remains available even in a typing burst.
    if (key.escape || (key.ctrl && input === "c")) return false;
    const now = performance.now();
    const printable = input.length > 0 && !key.ctrl && !key.meta && !key.super &&
      !/[\u0000-\u001f\u007f]/u.test(input);
    const shortcut = /^[123]$/u.test(input);
    const paste = event.keypress.isPasted;
    // The whole stdin batch is visible before its first key is dispatched.
    // Thus an unmarked paste beginning with "1" cannot approve prematurely.
    const textBurst = (event.textInBatch?.length ?? 0) > 1;
    const preserve = (): void => {
      if (composerDraft === undefined) return;
      draftFocusedRef.current = true;
      setDraftFocused(true);
      composerDraft.onInput(input, key);
    };
    if (draftFocusedRef.current && composerDraft !== undefined) {
      event.stopImmediatePropagation();
      // A separate Tab deliberately transfers focus. Digits, navigation and
      // Enter otherwise remain draft input, even after a long typing pause.
      if (key.tab && !key.shift && !paste && !textBurst) {
        draftFocusedRef.current = false;
        setDraftFocused(false);
        typedSinceChoice.current = false;
        lastTyping.current = Number.NEGATIVE_INFINITY;
        setWaiting(false);
      } else preserve();
      return true;
    }
    if (paste || textBurst || (printable && !shortcut) || now - lastTyping.current < APPROVAL_TYPING_QUIET_MS) {
      lastTyping.current = now;
      if (!typedConfirmation) typedSinceChoice.current = true;
      setWaiting(true);
      // Destructive cards still require their exact confirmation word. Allow
      // editing that word, but Enter must be a separate, deliberate gesture.
      if (typedConfirmation && !key.return) return false;
      if (!typedConfirmation) preserve();
      event.stopImmediatePropagation();
      return true;
    }
    if (!typedConfirmation && typedSinceChoice.current) {
      // A pause does not turn text intended for the composer into consent.
      // Enter stays blocked until a separate shortcut or navigation choice.
      if (key.return) {
        preserve();
        event.stopImmediatePropagation();
        return true;
      }
      if ((printable && shortcut) || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        typedSinceChoice.current = false;
      }
    }
    if (waiting && (typedConfirmation || !typedSinceChoice.current)) setWaiting(false);
    return false;
  }, [typedConfirmation, waiting, composerDraft]);
  return { waiting, blockTyping, draftFocused };
}
