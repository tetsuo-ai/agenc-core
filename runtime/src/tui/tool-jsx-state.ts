import { useCallback, useRef, useState } from "react";
import type React from "react";

/**
 * Mirrors the `toolJSX` state shape expected by the TUI shell.
 *
 * Tools that render their own UI surface (interactive prompts,
 * confirmation dialogs, slash-command JSX) call `setToolJSX` with a
 * value of this shape; the host renders the `jsx` field as a sibling
 * block beside `<Messages>` and gates spinner / animation / idle on
 * the other fields.
 */
export type ToolJSXState = {
  jsx: React.ReactNode | null;
  shouldHidePromptInput: boolean;
  shouldContinueAnimation?: true;
  showSpinner?: boolean;
  isLocalJSXCommand?: boolean;
  isImmediate?: boolean;
};

/**
 * Argument type for `setToolJSX`. Identical to {@link ToolJSXState} except
 * for `clearLocalJSX`, which is a one-shot directive consumed by the
 * wrapper (never written into state).
 */
export type ToolJSXArgs = {
  jsx: React.ReactNode | null;
  shouldHidePromptInput: boolean;
  shouldContinueAnimation?: true;
  showSpinner?: boolean;
  isLocalJSXCommand?: boolean;
  clearLocalJSX?: boolean;
};

export type ToolJSXUpdateResult =
  | { skip: true }
  | { skip?: false; nextState: ToolJSXState | null; nextLocalRef?: ToolJSXState | null };

/**
 * Pure decision function carrying the local-JSX preservation rules.
 * Returns the next React state value and (when
 * relevant) the next local-JSX-command ref value. Splitting this from
 * the React `useCallback` makes the local-JSX preservation rules
 * directly unit-testable without spinning up a renderer.
 */
export function applyToolJSXUpdate(
  args: ToolJSXArgs | null,
  prevLocalRef: ToolJSXState | null,
): ToolJSXUpdateResult {
  if (args && args.isLocalJSXCommand) {
    const { clearLocalJSX: _ignored, ...rest } = args;
    void _ignored;
    const persisted: ToolJSXState = { ...rest, isLocalJSXCommand: true };
    return {
      nextState: rest,
      nextLocalRef: persisted,
    };
  }

  if (prevLocalRef !== null) {
    if (args && args.clearLocalJSX) {
      return { nextState: null, nextLocalRef: null };
    }
    return { skip: true };
  }

  if (args && args.clearLocalJSX) {
    return { nextState: null };
  }

  return { nextState: args };
}

/**
 * React hook providing the TUI `toolJSX` state contract. Returns
 * `[toolJSX, setToolJSX]` where `setToolJSX` preserves local-JSX
 * commands across normal tool updates.
 */
export function useToolJSX(): readonly [
  ToolJSXState | null,
  (args: ToolJSXArgs | null) => void,
] {
  const [toolJSX, setToolJSXInternal] = useState<ToolJSXState | null>(null);
  const localJSXCommandRef = useRef<ToolJSXState | null>(null);

  const setToolJSX = useCallback((args: ToolJSXArgs | null) => {
    const result = applyToolJSXUpdate(args, localJSXCommandRef.current);
    if ("skip" in result && result.skip) return;
    if ("nextLocalRef" in result && result.nextLocalRef !== undefined) {
      localJSXCommandRef.current = result.nextLocalRef;
    }
    if ("nextState" in result) {
      setToolJSXInternal(result.nextState);
    }
  }, []);

  return [toolJSX, setToolJSX] as const;
}
