import { extname } from "node:path";

import stripAnsi from "strip-ansi";
import wrapAnsi from "wrap-ansi";

import { getCliHighlightPromise } from "../../utils/cliHighlight.js";

export interface HighlightedCodeLine {
  readonly text: string;
  readonly plainText: string;
}

export interface HighlightCodeOptions {
  readonly code: string;
  readonly filePath?: string;
  readonly language?: string;
  readonly width?: number;
}

function normalizeWidth(width: number | undefined): number {
  return Number.isFinite(width) && typeof width === "number"
    ? Math.max(1, Math.floor(width))
    : 80;
}

function wrapRenderedLines(source: string, width: number): HighlightedCodeLine[] {
  const wrapped: HighlightedCodeLine[] = [];
  const normalized = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const line of normalized) {
    const segments = wrapAnsi(line, width, {
      hard: true,
      trim: false,
      wordWrap: false,
    }).split("\n");
    const output = segments.length > 0 ? segments : [""];
    for (const segment of output) {
      wrapped.push({
        text: segment,
        plainText: stripAnsi(segment),
      });
    }
  }
  return wrapped;
}

function resolveLanguage(
  filePath: string | undefined,
  language: string | undefined,
): string | undefined {
  if (typeof language === "string" && language.trim().length > 0) {
    return language.trim();
  }
  const extension = extname(filePath ?? "").replace(/^\./, "").trim();
  return extension.length > 0 ? extension : undefined;
}

export function renderPlainCodeLines(
  code: string,
  width?: number,
): HighlightedCodeLine[] {
  return wrapRenderedLines(String(code ?? ""), normalizeWidth(width));
}

export async function renderHighlightedCodeLines(
  options: HighlightCodeOptions,
): Promise<HighlightedCodeLine[] | null> {
  const highlight = await getCliHighlightPromise();
  if (highlight === null) {
    return null;
  }
  const width = normalizeWidth(options.width);
  const requestedLanguage = resolveLanguage(options.filePath, options.language);
  const language =
    requestedLanguage && highlight.supportsLanguage(requestedLanguage)
      ? requestedLanguage
      : "plaintext";
  const previousForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = previousForceColor && previousForceColor.length > 0
    ? previousForceColor
    : "1";
  const rendered = highlight.highlight(options.code, {
    language,
    ignoreIllegals: true,
  });
  if (previousForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = previousForceColor;
  }
  return wrapRenderedLines(rendered, width);
}
