import { displayPathRelativeToBase } from "../pathDisplay.js";
import { normalizeWorkspacePathForReferences } from "../workbench/pathReferences.js";

export interface RipgrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function parseRipgrepJsonLine(line: string): RipgrepMatch | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const event = message as {
    readonly type?: unknown;
    readonly data?: {
      readonly path?: { readonly text?: unknown };
      readonly line_number?: unknown;
      readonly lines?: { readonly text?: unknown };
    };
  };
  if (event.type !== "match") return null;
  const file = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  const text = event.data?.lines?.text;
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    typeof lineNumber !== "number" ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    typeof text !== "string"
  ) {
    return null;
  }
  return { file, line: lineNumber, text: stripJsonLineTerminator(text) };
}

function stripJsonLineTerminator(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
}

export function normalizeRipgrepMatchPath(rawFile: string, cwd: string): string {
  const file = normalizeWorkspacePathForReferences(rawFile);
  const base = normalizeWorkspacePathForReferences(cwd);
  return displayPathRelativeToBase(base, file);
}
