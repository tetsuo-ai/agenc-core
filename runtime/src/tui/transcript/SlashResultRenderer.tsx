/**
 * SlashResultRenderer — renders a `SlashCommandResult` (T11) as a
 * transcript entry inside the Wave 4 TUI.
 *
 * Scope (T12 Wave 4-C):
 *   - Each `kind` of the discriminated result union maps to one small
 *     presentational shape so the transcript can slot the component in
 *     without any kind-specific branching at the call site.
 *   - `kind: "prompt"` fires `onPromptInject` once on mount so the
 *     Composer can re-inject the returned content as the next user
 *     prompt. The render itself is passive — it marks the entry with
 *     a `▸` sigil so the operator can see which line originated from a
 *     slash-command prompt rewrite.
 *   - `kind: "skip"` renders nothing (returns `null`) so the
 *     dispatcher can flush the entry without occupying a visible line.
 *   - `kind: "exit"` / `kind: "error"` use the shared theme red for
 *     the prefix so they're unambiguous at a glance.
 *
 * Rendering invariants:
 *   - Never mentions a specific provider/brand in the rendered strings
 *     (provider-neutral cockpit UI).
 *   - The `input` prop is rendered as-is for the text/compact kinds so
 *     the user sees the exact command they typed in the transcript
 *     header. Kept intentionally in the same line as the result body
 *     for the "compact" variant.
 *
 * @module
 */

import React, { useEffect } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";

import type { SlashCommandResult } from "../../commands/types.js";

export interface SlashResultProps {
  /** Raw user input (e.g. `/help` or `/model grok-4`). Rendered as-is. */
  readonly input: string;
  /** The command outcome produced by the dispatcher. */
  readonly result: SlashCommandResult;
  /**
   * Invoked once on mount when `result.kind === "prompt"`. The Composer
   * re-injects `result.content` as the next user prompt. Absent for
   * non-prompt kinds.
   */
  readonly onPromptInject?: (text: string) => void;
}

/**
 * Tiny sigil marking prompt-kind rewrites so they're visually
 * distinguishable from ordinary text results.
 */
const PROMPT_SIGIL = "\u25B8"; // ▸

export const SlashResultRenderer: React.FC<SlashResultProps> = ({
  input,
  result,
  onPromptInject,
}) => {
  // `prompt` needs an effect so the Composer's setter fires exactly
  // once per mount even if React strict-mode double-invokes render.
  useEffect(() => {
    if (result.kind === "prompt") {
      onPromptInject?.(result.content);
    }
    // Intentional: only re-fire if the emitted content string changes.
    // Re-mount of the component (new transcript entry) is the normal
    // way consumers fire a new prompt injection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.kind, result.kind === "prompt" ? result.content : null]);

  switch (result.kind) {
    case "text":
      return (
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text dim>{input}</Text>
          <Text>{result.text}</Text>
        </Box>
      );

    case "compact":
      return <Text dim>{`${input}  ${result.text}`}</Text>;

    case "prompt":
      return (
        <Box flexDirection="column">
          <Text color="cyan">{`${PROMPT_SIGIL} ${input}`}</Text>
          <Text>{result.content}</Text>
        </Box>
      );

    case "skip":
      return null;

    case "exit":
      return <Text color="red">{`Exiting (code ${result.code})`}</Text>;

    case "error":
      return <Text color="red">{`agenc: ${result.message}`}</Text>;

    default: {
      // Exhaustiveness guard — if a new kind is added to the union
      // without updating this switch, the `never` assignment below
      // flags it at compile time. At runtime we render nothing rather
      // than throw, because a transcript renderer must never crash the
      // TUI for an unknown variant.
      const _never: never = result;
      void _never;
      return null;
    }
  }
};

export default SlashResultRenderer;
