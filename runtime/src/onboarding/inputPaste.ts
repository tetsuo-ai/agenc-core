export const MAX_ONBOARDING_INPUT_LENGTH = 10_000;
const ONBOARDING_INPUT_PREVIEW_LENGTH = 1_000;

export interface PastedContent {
  readonly id: number;
  readonly content: string;
  readonly lineCount: number;
}

export interface TruncatedInput {
  readonly text: string;
  readonly pastedContent?: PastedContent;
}

export interface InputPasteResult {
  readonly input: string;
  readonly pastedContents: readonly PastedContent[];
}

function getPastedTextLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function maybeTruncateMessageForInput(
  text: string,
  nextPasteId = 1,
): TruncatedInput {
  if (text.length <= MAX_ONBOARDING_INPUT_LENGTH) {
    return { text };
  }
  const prefix = text.slice(0, ONBOARDING_INPUT_PREVIEW_LENGTH);
  const suffix = text.slice(-ONBOARDING_INPUT_PREVIEW_LENGTH);
  const omitted = text.slice(
    ONBOARDING_INPUT_PREVIEW_LENGTH,
    -ONBOARDING_INPUT_PREVIEW_LENGTH,
  );
  const pastedContent: PastedContent = {
    id: nextPasteId,
    content: omitted,
    lineCount: getPastedTextLineCount(omitted),
  };
  return {
    text: [
      prefix,
      `[Pasted content #${nextPasteId}: ${omitted.length} characters, ${pastedContent.lineCount} lines]`,
      suffix,
    ].join("\n"),
    pastedContent,
  };
}

export function maybeTruncateInput(
  input: string,
  pastedContents: readonly PastedContent[] = [],
): InputPasteResult {
  const truncated = maybeTruncateMessageForInput(
    input,
    pastedContents.length + 1,
  );
  if (truncated.pastedContent === undefined) {
    return { input: truncated.text, pastedContents };
  }
  return {
    input: truncated.text,
    pastedContents: [...pastedContents, truncated.pastedContent],
  };
}
