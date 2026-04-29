/**
 * One-shot effect that detects oversize composer buffers (e.g. paste
 * blobs that landed before bracketed-paste detection had a chance to
 * stash them) and rewrites them through `maybeTruncateInput`.
 *
 * The hook keeps a single boolean of "we already collapsed this draft"
 * so it never fights the user once they start editing again, and resets
 * that boolean whenever the buffer goes back to empty (post-submit).
 */

import { useEffect, useState } from "react";

import { maybeTruncateInput, type PastedContent } from "./inputPaste.js";

type Props = {
  readonly input: string;
  readonly pastedContents: Record<number, PastedContent>;
  readonly onInputChange: (input: string) => void;
  readonly setCursorOffset: (offset: number) => void;
  readonly setPastedContents: (
    contents: Record<number, PastedContent>,
  ) => void;
};

export function useMaybeTruncateInput({
  input,
  pastedContents,
  onInputChange,
  setCursorOffset,
  setPastedContents,
}: Props): void {
  // Track if we've initialized this specific input value
  const [hasAppliedTruncationToInput, setHasAppliedTruncationToInput] =
    useState(false);

  useEffect(() => {
    if (hasAppliedTruncationToInput) {
      return;
    }
    if (input.length <= 10_000) {
      return;
    }

    const { newInput, newPastedContents } = maybeTruncateInput(
      input,
      pastedContents,
    );

    onInputChange(newInput);
    setCursorOffset(newInput.length);
    setPastedContents(newPastedContents);
    setHasAppliedTruncationToInput(true);
  }, [
    input,
    hasAppliedTruncationToInput,
    pastedContents,
    onInputChange,
    setPastedContents,
    setCursorOffset,
  ]);

  useEffect(() => {
    if (input === "") {
      setHasAppliedTruncationToInput(false);
    }
  }, [input]);
}
