import { structuredPatch, type StructuredPatchHunk } from "diff";

import { addToTotalLinesChanged } from "../cost-tracker.js";
import { convertLeadingTabsToSpaces } from "./file.js";

export const CONTEXT_LINES = 3;
export const DIFF_TIMEOUT_MS = 5_000;

interface FileEditLike {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

export function adjustHunkLineNumbers(
  hunks: readonly StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  if (offset === 0) {
    return [...hunks];
  }
  return hunks.map((hunk) => ({
    ...hunk,
    oldStart: hunk.oldStart + offset,
    newStart: hunk.newStart + offset,
  }));
}

const AMPERSAND_TOKEN = "<<:AMPERSAND_TOKEN:>>";
const DOLLAR_TOKEN = "<<:DOLLAR_TOKEN:>>";

function escapeForDiff(value: string): string {
  return value.replaceAll("&", AMPERSAND_TOKEN).replaceAll("$", DOLLAR_TOKEN);
}

function unescapeFromDiff(value: string): string {
  return value.replaceAll(AMPERSAND_TOKEN, "&").replaceAll(DOLLAR_TOKEN, "$");
}

function normalizePatch(
  patch: ReturnType<typeof structuredPatch> | undefined,
): StructuredPatchHunk[] {
  if (!patch) {
    return [];
  }
  return patch.hunks.map((hunk) => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff),
  }));
}

export function countLinesChanged(
  patch: readonly StructuredPatchHunk[],
  newFileContent?: string,
): { readonly additions: number; readonly removals: number } {
  let additions = 0;
  let removals = 0;

  if (patch.length === 0 && typeof newFileContent === "string" && newFileContent.length > 0) {
    additions = newFileContent.split(/\r?\n/).length;
  } else {
    for (const hunk of patch) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          additions += 1;
        } else if (line.startsWith("-")) {
          removals += 1;
        }
      }
    }
  }

  addToTotalLinesChanged(additions, removals);
  return { additions, removals };
}

export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  readonly filePath: string;
  readonly oldContent: string;
  readonly newContent: string;
  readonly ignoreWhitespace?: boolean;
  readonly singleHunk?: boolean;
}): StructuredPatchHunk[] {
  return normalizePatch(
    structuredPatch(
      filePath,
      filePath,
      escapeForDiff(oldContent),
      escapeForDiff(newContent),
      undefined,
      undefined,
      {
        ignoreWhitespace,
        context: singleHunk ? 100_000 : CONTEXT_LINES,
        timeout: DIFF_TIMEOUT_MS,
      },
    ),
  );
}

export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  readonly filePath: string;
  readonly fileContents: string;
  readonly edits: readonly FileEditLike[];
  readonly ignoreWhitespace?: boolean;
}): StructuredPatchHunk[] {
  const preparedContents = escapeForDiff(convertLeadingTabsToSpaces(fileContents));
  const nextContents = edits.reduce((output, edit) => {
    const oldString = escapeForDiff(convertLeadingTabsToSpaces(edit.old_string));
    const newString = escapeForDiff(convertLeadingTabsToSpaces(edit.new_string));
    if (edit.replace_all) {
      return output.replaceAll(oldString, () => newString);
    }
    return output.replace(oldString, () => newString);
  }, preparedContents);

  return normalizePatch(
    structuredPatch(
      filePath,
      filePath,
      preparedContents,
      nextContents,
      undefined,
      undefined,
      {
        context: CONTEXT_LINES,
        ignoreWhitespace,
        timeout: DIFF_TIMEOUT_MS,
      },
    ),
  );
}
